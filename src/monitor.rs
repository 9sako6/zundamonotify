use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(1500);
pub const DEFAULT_COMPLETION_DELAY: Duration = Duration::from_millis(2000);
const MAX_IGNORED_SESSIONS: usize = 1024;
const READ_CHUNK_BYTES: usize = 8 * 1024;
const MAX_BYTES_PER_POLL: usize = 256 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;

pub type CompletionHandler = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug)]
pub enum MonitorSource {
    Codex { sessions_dir: PathBuf },
    ClaudeCode { projects_dir: PathBuf },
    OpenCode { log_path: PathBuf },
}

impl MonitorSource {
    pub fn codex_default() -> Self {
        Self::Codex {
            sessions_dir: home_dir().join(".codex/sessions"),
        }
    }

    pub fn claude_code_default() -> Self {
        Self::ClaudeCode {
            projects_dir: home_dir().join(".claude/projects"),
        }
    }

    pub fn opencode_default() -> Self {
        let data_home = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local/share"));
        Self::OpenCode {
            log_path: data_home.join("opencode/log/opencode.log"),
        }
    }

    fn list_files(&self, now: SystemTime) -> Vec<PathBuf> {
        match self {
            Self::Codex { sessions_dir } => codex_session_files(sessions_dir, now),
            Self::ClaudeCode { projects_dir } => claude_session_files(projects_dir),
            Self::OpenCode { log_path } => vec![log_path.clone()],
        }
    }

    fn new_state(&self) -> ParserState {
        match self {
            Self::Codex { .. } => ParserState::Codex(CodexState::default()),
            Self::ClaudeCode { .. } => ParserState::ClaudeCode(ClaudeCodeState::default()),
            Self::OpenCode { .. } => ParserState::OpenCode(OpenCodeState::default()),
        }
    }
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn codex_session_files(root: &Path, now: SystemTime) -> Vec<PathBuf> {
    let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as libc::time_t;
    let mut files = Vec::new();

    for days_ago in [0, 1] {
        let Some((year, month, date)) = local_date(seconds, days_ago) else {
            continue;
        };
        let dir = root
            .join(format!("{year:04}"))
            .join(format!("{month:02}"))
            .join(format!("{date:02}"));
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                files.push(entry.path());
            }
        }
    }

    files
}

fn local_date(seconds: libc::time_t, days_ago: i32) -> Option<(i32, u32, u32)> {
    let mut local = unsafe {
        let mut value = std::mem::zeroed();
        if libc::localtime_r(&seconds, &mut value).is_null() {
            return None;
        }
        value
    };
    local.tm_mday -= days_ago;
    if unsafe { libc::mktime(&mut local) } == -1 {
        return None;
    }
    Some((
        local.tm_year + 1900,
        (local.tm_mon + 1) as u32,
        local.tm_mday as u32,
    ))
}

fn claude_session_files(root: &Path) -> Vec<PathBuf> {
    let Ok(projects) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_string_lossy().ends_with(".jsonl")
            {
                files.push(entry.path());
            }
        }
    }
    files
}

#[derive(Debug)]
struct TrackedFile {
    identity: (u64, u64),
    offset: u64,
    partial: Vec<u8>,
    discarding_oversized_line: bool,
    parser: ParserState,
}

impl TrackedFile {
    fn new(metadata: &Metadata, parser: ParserState) -> Self {
        Self {
            identity: (metadata.dev(), metadata.ino()),
            offset: 0,
            partial: Vec::new(),
            discarding_oversized_line: false,
            parser,
        }
    }

    fn read_lines(&mut self, file: &mut File, available: u64) -> std::io::Result<Vec<Vec<u8>>> {
        let mut lines = Vec::new();
        let mut remaining = available.min(MAX_BYTES_PER_POLL as u64) as usize;
        let mut buffer = [0_u8; READ_CHUNK_BYTES];

        while remaining > 0 {
            let requested = remaining.min(buffer.len());
            let read = file.read(&mut buffer[..requested])?;
            if read == 0 {
                break;
            }
            self.offset += read as u64;
            remaining -= read;

            for byte in &buffer[..read] {
                if self.discarding_oversized_line {
                    if *byte == b'\n' {
                        self.discarding_oversized_line = false;
                    }
                    continue;
                }
                if *byte == b'\n' {
                    lines.push(std::mem::take(&mut self.partial));
                } else if self.partial.len() < MAX_LINE_BYTES {
                    self.partial.push(*byte);
                } else {
                    self.partial.clear();
                    self.discarding_oversized_line = true;
                }
            }
        }

        Ok(lines)
    }
}

#[derive(Debug)]
enum ParserState {
    Codex(CodexState),
    ClaudeCode(ClaudeCodeState),
    OpenCode(OpenCodeState),
}

impl ParserState {
    fn process_line(&mut self, line: &str) -> bool {
        match self {
            Self::Codex(state) => state.process_line(line),
            Self::ClaudeCode(state) => state.process_line(line),
            Self::OpenCode(state) => state.process_line(line),
        }
    }
}

#[derive(Debug, Default)]
struct CodexState {
    last_completed_turn_id: Option<String>,
    ignored: bool,
    ignored_turns: HashSet<String>,
}

impl CodexState {
    fn process_line(&mut self, line: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        let event_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload");

        if event_type == Some("session_meta") {
            if payload
                .and_then(|p| p.pointer("/source/subagent/other"))
                .and_then(Value::as_str)
                == Some("guardian")
            {
                self.ignored = true;
            }
            return false;
        }

        if event_type == Some("turn_context") {
            let model = payload.and_then(|p| p.get("model")).and_then(Value::as_str);
            let turn_id = payload
                .and_then(|p| p.get("turn_id"))
                .and_then(Value::as_str);
            if model == Some("codex-auto-review")
                && let Some(turn_id) = turn_id
            {
                self.ignored_turns.insert(turn_id.to_owned());
            }
            return false;
        }

        if event_type != Some("event_msg")
            || payload.and_then(|p| p.get("type")).and_then(Value::as_str) != Some("task_complete")
        {
            return false;
        }

        let turn_id = payload
            .and_then(|p| p.get("turn_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if self.ignored
            || turn_id
                .as_ref()
                .is_some_and(|id| self.ignored_turns.contains(id))
            || turn_id
                .as_ref()
                .is_some_and(|id| self.last_completed_turn_id.as_ref() == Some(id))
        {
            return false;
        }
        self.last_completed_turn_id = turn_id;
        true
    }
}

#[derive(Debug, Default)]
struct ClaudeCodeState {
    last_completed_turn_id: Option<String>,
}

impl ClaudeCodeState {
    fn process_line(&mut self, line: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant")
            || value
                .pointer("/message/stop_reason")
                .and_then(Value::as_str)
                != Some("end_turn")
        {
            return false;
        }
        let turn_id = value.get("uuid").and_then(Value::as_str).map(str::to_owned);
        if turn_id
            .as_ref()
            .is_some_and(|id| self.last_completed_turn_id.as_ref() == Some(id))
        {
            return false;
        }
        self.last_completed_turn_id = turn_id;
        true
    }
}

#[derive(Debug, Default)]
struct OpenCodeState {
    ignored_sessions: HashSet<String>,
    ignored_order: VecDeque<String>,
}

impl OpenCodeState {
    fn process_line(&mut self, line: &str) -> bool {
        let message = read_field(line, "message");
        if message.as_deref() == Some("created") {
            let Some(session_id) = read_field(line, "id") else {
                return false;
            };
            let parent_id = read_field(line, "parentID");
            if parent_id
                .as_deref()
                .is_some_and(|value| value != "undefined")
            {
                self.ignore_session(session_id);
            } else {
                self.ignored_sessions.remove(&session_id);
                self.ignored_order.retain(|id| id != &session_id);
            }
            return false;
        }
        if message.as_deref() != Some("exiting loop") {
            return false;
        }
        read_field(line, "session.id").is_some_and(|id| !self.ignored_sessions.contains(&id))
    }

    fn ignore_session(&mut self, session_id: String) {
        if !self.ignored_sessions.insert(session_id.clone()) {
            return;
        }
        if self.ignored_order.len() >= MAX_IGNORED_SESSIONS
            && let Some(oldest) = self.ignored_order.pop_front()
        {
            self.ignored_sessions.remove(&oldest);
        }
        self.ignored_order.push_back(session_id);
    }
}

fn read_field(line: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let mut search_from = 0;
    let start = loop {
        let relative = line[search_from..].find(&needle)?;
        let index = search_from + relative;
        if index == 0 || line.as_bytes()[index - 1] == b' ' {
            break index + needle.len();
        }
        search_from = index + needle.len();
    };
    let rest = &line[start..];
    if !rest.starts_with('"') {
        return Some(rest.split(' ').next().unwrap_or_default().to_owned());
    }

    let mut escaped = false;
    let mut end = None;
    for (index, character) in rest[1..].char_indices() {
        if character == '"' && !escaped {
            end = Some(index + 1);
            break;
        }
        escaped = character == '\\' && !escaped;
        if character != '\\' {
            escaped = false;
        }
    }
    let raw = &rest[..=end?];
    serde_json::from_str(raw).ok()
}

pub struct LogMonitor {
    source: MonitorSource,
    tracked: HashMap<PathBuf, TrackedFile>,
    has_primed: bool,
    completion_delay: Duration,
    on_complete: CompletionHandler,
}

impl LogMonitor {
    pub fn new(
        source: MonitorSource,
        completion_delay: Duration,
        on_complete: CompletionHandler,
    ) -> Self {
        Self {
            source,
            tracked: HashMap::new(),
            has_primed: false,
            completion_delay,
            on_complete,
        }
    }

    pub fn poll(&mut self, now: SystemTime) {
        let files = self.source.list_files(now);
        let active: HashSet<_> = files.iter().cloned().collect();
        for path in files {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            self.poll_file(&path, &metadata);
        }
        self.tracked
            .retain(|path, _| active.contains(path) && path.exists());
        self.has_primed = true;
    }

    fn poll_file(&mut self, path: &Path, metadata: &Metadata) {
        let identity = (metadata.dev(), metadata.ino());
        let mut notify = self.has_primed;
        let replaced = self
            .tracked
            .get(path)
            .is_some_and(|entry| entry.identity != identity || metadata.len() < entry.offset);
        if replaced {
            self.tracked.insert(
                path.to_owned(),
                TrackedFile::new(metadata, self.source.new_state()),
            );
            notify = false;
        } else if !self.tracked.contains_key(path) {
            self.tracked.insert(
                path.to_owned(),
                TrackedFile::new(metadata, self.source.new_state()),
            );
        }

        let entry = self.tracked.get_mut(path).expect("tracked file exists");
        if metadata.len() <= entry.offset {
            return;
        }
        let Ok(mut file) = File::open(path) else {
            return;
        };
        if file.seek(SeekFrom::Start(entry.offset)).is_err() {
            return;
        }
        let remaining = metadata.len() - entry.offset;
        let Ok(lines) = entry.read_lines(&mut file, remaining) else {
            return;
        };

        for line in lines {
            let line = String::from_utf8_lossy(&line);
            if line.trim().is_empty() || !entry.parser.process_line(&line) || !notify {
                continue;
            }
            let delay = self.completion_delay;
            let handler = Arc::clone(&self.on_complete);
            thread::spawn(move || {
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                handler();
            });
        }
    }
}

pub fn start_default_monitors(on_complete: CompletionHandler) {
    for source in [
        MonitorSource::codex_default(),
        MonitorSource::claude_code_default(),
        MonitorSource::opencode_default(),
    ] {
        let handler = Arc::clone(&on_complete);
        thread::spawn(move || {
            let mut monitor = LogMonitor::new(source, DEFAULT_COMPLETION_DELAY, handler);
            loop {
                monitor.poll(SystemTime::now());
                thread::sleep(DEFAULT_POLL_INTERVAL);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{OpenOptions, create_dir_all, remove_dir_all, rename, write};
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path =
                env::temp_dir().join(format!("zundamonotify-{name}-{}-{id}", std::process::id()));
            create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = remove_dir_all(&self.0);
        }
    }

    fn append(path: &Path, text: &str) {
        append_bytes(path, text.as_bytes());
    }

    fn append_bytes(path: &Path, bytes: &[u8]) {
        OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

    fn counter() -> (Arc<AtomicUsize>, CompletionHandler) {
        let count = Arc::new(AtomicUsize::new(0));
        let target = Arc::clone(&count);
        let handler = Arc::new(move || {
            target.fetch_add(1, Ordering::SeqCst);
        });
        (count, handler)
    }

    fn wait_for(count: &AtomicUsize, expected: usize) {
        for _ in 0..100 {
            if count.load(Ordering::SeqCst) == expected {
                return;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(count.load(Ordering::SeqCst), expected);
    }

    #[test]
    fn codex_notifies_only_new_task_completions() {
        let root = TempDir::new("codex");
        let dir = root.0.join("2026/04/24");
        create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-session.jsonl");
        write(&file, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"old\"}}\n").unwrap();
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::Codex {
                sessions_dir: root.0.clone(),
            },
            Duration::ZERO,
            handler,
        );
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        append(
            &file,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"new\"}}\n",
        );
        monitor.poll(now);
        wait_for(&count, 1);
    }

    #[test]
    fn codex_deduplicates_and_ignores_internal_sessions() {
        let mut state = CodexState::default();
        assert!(!state.process_line("not-json"));
        assert!(!state.process_line("{\"type\":\"turn_context\",\"payload\":{\"model\":\"codex-auto-review\",\"turn_id\":\"review\"}}"));
        assert!(!state.process_line("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"review\"}}"));
        assert!(state.process_line(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
        ));
        assert!(!state.process_line(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
        ));

        let mut guardian = CodexState::default();
        assert!(!guardian.process_line("{\"type\":\"session_meta\",\"payload\":{\"source\":{\"subagent\":{\"other\":\"guardian\"}}}}"));
        assert!(!guardian.process_line(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
        ));
    }

    #[test]
    fn missing_event_ids_do_not_suppress_completions() {
        let mut codex = CodexState::default();
        let codex_event = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}";
        assert!(codex.process_line(codex_event));
        assert!(codex.process_line(codex_event));

        let mut claude = ClaudeCodeState::default();
        let claude_event = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}";
        assert!(claude.process_line(claude_event));
        assert!(claude.process_line(claude_event));
    }

    #[test]
    fn claude_notifies_end_turn_once() {
        let mut state = ClaudeCodeState::default();
        assert!(!state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"tool_use\"}}"
        ));
        assert!(state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}"
        ));
        assert!(!state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}"
        ));
    }

    #[test]
    fn claude_lists_only_direct_jsonl_files() {
        let root = TempDir::new("claude");
        let project = root.0.join("project");
        let subagents = project.join("session/subagents");
        create_dir_all(&subagents).unwrap();
        write(project.join("session.jsonl"), "").unwrap();
        write(project.join("note.txt"), "").unwrap();
        write(subagents.join("agent.jsonl"), "").unwrap();
        assert_eq!(
            claude_session_files(&root.0),
            vec![project.join("session.jsonl")]
        );
    }

    #[test]
    fn opencode_tracks_parent_sessions_and_quoted_fields() {
        let mut state = OpenCodeState::default();
        assert!(!state.process_line("id=child parentID=parent message=created"));
        assert!(!state.process_line("session.id=child message=\"exiting loop\""));
        assert!(state.process_line("session.id=root message=\"exiting loop\""));
        assert_eq!(
            read_field("message=\"hello \\\"zunda\\\"\"", "message").as_deref(),
            Some("hello \"zunda\"")
        );
        assert_eq!(
            read_field("notmessage=wrong message=right", "message").as_deref(),
            Some("right")
        );
    }

    #[test]
    fn opencode_bounds_ignored_session_state() {
        let mut state = OpenCodeState::default();
        for index in 0..=MAX_IGNORED_SESSIONS {
            assert!(
                !state.process_line(&format!("id=child-{index} parentID=parent message=created"))
            );
        }
        assert_eq!(state.ignored_sessions.len(), MAX_IGNORED_SESSIONS);
        assert!(!state.ignored_sessions.contains("child-0"));
        assert!(
            state
                .ignored_sessions
                .contains(&format!("child-{MAX_IGNORED_SESSIONS}"))
        );
    }

    #[test]
    fn truncation_and_replacement_prime_new_generations() {
        let root = TempDir::new("rotation");
        let file = root.0.join("events.log");
        write(&file, "message=\"exiting loop\" session.id=old-history\n").unwrap();
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::OpenCode {
                log_path: file.clone(),
            },
            Duration::ZERO,
            handler,
        );
        monitor.poll(SystemTime::now());
        append(&file, "message=\"exiting loop\" session.id=first\n");
        monitor.poll(SystemTime::now());
        wait_for(&count, 1);

        write(&file, "message=\"exiting loop\" session.id=new-history\n").unwrap();
        monitor.poll(SystemTime::now());
        append(
            &file,
            "message=\"exiting loop\" session.id=after-truncate\n",
        );
        monitor.poll(SystemTime::now());
        wait_for(&count, 2);

        let replacement = root.0.join("replacement.log");
        write(
            &replacement,
            "message=\"exiting loop\" session.id=replacement-history\n",
        )
        .unwrap();
        rename(&replacement, &file).unwrap();
        monitor.poll(SystemTime::now());
        append(&file, "message=\"exiting loop\" session.id=after-replace\n");
        monitor.poll(SystemTime::now());
        wait_for(&count, 3);
    }

    #[test]
    fn partial_lines_wait_for_the_newline_and_completion_delay() {
        let root = TempDir::new("partial");
        let file = root.0.join("events.log");
        write(&file, "").unwrap();
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::OpenCode {
                log_path: file.clone(),
            },
            Duration::from_millis(20),
            handler,
        );
        monitor.poll(SystemTime::now());
        append(&file, "message=\"exiting loop\" session.id=one");
        monitor.poll(SystemTime::now());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        append(&file, "\n");
        monitor.poll(SystemTime::now());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        wait_for(&count, 1);
    }

    #[test]
    fn oversized_records_are_discarded_without_losing_the_next_event() {
        let root = TempDir::new("oversized");
        let file = root.0.join("events.log");
        write(&file, "").unwrap();
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::OpenCode {
                log_path: file.clone(),
            },
            Duration::ZERO,
            handler,
        );
        monitor.poll(SystemTime::now());

        let mut records = vec![b'x'; MAX_LINE_BYTES + 1];
        records.extend_from_slice(b"\nmessage=\"exiting loop\" session.id=valid\n");
        append_bytes(&file, &records);
        monitor.poll(SystemTime::now());

        wait_for(&count, 1);
        let tracked = monitor.tracked.get(&file).unwrap();
        assert!(tracked.partial.len() <= MAX_LINE_BYTES);
        assert!(!tracked.discarding_oversized_line);
    }

    #[test]
    fn each_poll_reads_only_its_byte_budget() {
        let root = TempDir::new("poll-budget");
        let file = root.0.join("events.log");
        write(&file, "").unwrap();
        let (_, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::OpenCode {
                log_path: file.clone(),
            },
            Duration::ZERO,
            handler,
        );
        monitor.poll(SystemTime::now());

        let records = vec![b'x'; MAX_BYTES_PER_POLL + 1];
        append_bytes(&file, &records);
        monitor.poll(SystemTime::now());

        let tracked = monitor.tracked.get(&file).unwrap();
        assert_eq!(tracked.offset, MAX_BYTES_PER_POLL as u64);
        assert!(tracked.partial.len() <= MAX_LINE_BYTES);
        assert!(tracked.discarding_oversized_line);
    }

    #[test]
    fn claude_monitors_multiple_projects() {
        let root = TempDir::new("claude-projects");
        let file_a = root.0.join("project-a/session-a.jsonl");
        let file_b = root.0.join("project-b/session-b.jsonl");
        create_dir_all(file_a.parent().unwrap()).unwrap();
        create_dir_all(file_b.parent().unwrap()).unwrap();
        write(&file_a, "").unwrap();
        write(&file_b, "").unwrap();
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::ClaudeCode {
                projects_dir: root.0.clone(),
            },
            Duration::ZERO,
            handler,
        );
        monitor.poll(SystemTime::now());
        let event = "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}\n";
        append(&file_a, event);
        append(&file_b, event);
        monitor.poll(SystemTime::now());
        wait_for(&count, 2);
    }

    #[test]
    fn local_date_can_move_to_the_previous_day() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        assert_ne!(local_date(now, 0), local_date(now, 1));
    }
}
