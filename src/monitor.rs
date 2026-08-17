use crate::{NotificationEvent, NotificationHandler};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(1500);
pub const DEFAULT_COMPLETION_DELAY: Duration = Duration::from_millis(2000);
const MAX_IGNORED_SESSIONS: usize = 1024;
const READ_CHUNK_BYTES: usize = 8 * 1024;
const MAX_BYTES_PER_POLL: usize = 256 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const HERMES_MAX_ROWS_PER_POLL: usize = 400;
const HERMES_SQLITE_BUSY_TIMEOUT_MS: i32 = 200;
const CLAUDE_INPUT_WAIT_DEDUP_WINDOW: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct EventDispatcher {
    completion: CompletionDispatch,
    handler: NotificationHandler,
}

#[derive(Clone)]
enum CompletionDispatch {
    Background(SyncSender<()>),
    Inline,
}

impl EventDispatcher {
    fn new(delay: Duration, handler: NotificationHandler) -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        let background_handler = Arc::clone(&handler);
        let completion = thread::Builder::new()
            .name("zundamonotify-completions".to_owned())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    if !delay.is_zero() {
                        thread::sleep(delay);
                    }
                    while receiver.try_recv().is_ok() {}
                    background_handler(NotificationEvent::Stop);
                }
            })
            .ok()
            .map_or(CompletionDispatch::Inline, |_| {
                CompletionDispatch::Background(sender)
            });
        Self {
            completion,
            handler,
        }
    }

    fn dispatch(&self, event: NotificationEvent) {
        match event {
            NotificationEvent::Notification => (self.handler)(event),
            NotificationEvent::Stop => match &self.completion {
                CompletionDispatch::Background(sender) => match sender.try_send(()) {
                    Ok(()) | Err(TrySendError::Full(())) => {}
                    Err(TrySendError::Disconnected(())) => (self.handler)(event),
                },
                CompletionDispatch::Inline => (self.handler)(event),
            },
        }
    }
}

#[derive(Clone, Debug)]
pub enum MonitorSource {
    Codex {
        sessions_dir: PathBuf,
    },
    ClaudeCode {
        projects_dir: PathBuf,
        sessions_dir: PathBuf,
    },
    OpenCode {
        log_path: PathBuf,
    },
    Hermes {
        db_paths: Vec<PathBuf>,
    },
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
            sessions_dir: home_dir().join(".claude/sessions"),
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

    pub fn hermes_default() -> Self {
        Self::Hermes {
            db_paths: hermes_db_paths(),
        }
    }

    fn list_files(&self, now: SystemTime) -> Vec<PathBuf> {
        match self {
            Self::Codex { sessions_dir } => codex_session_files(sessions_dir, now),
            Self::ClaudeCode { projects_dir, .. } => claude_session_files(projects_dir),
            Self::OpenCode { log_path } => vec![log_path.clone()],
            Self::Hermes { .. } => Vec::new(),
        }
    }

    fn new_state(&self) -> ParserState {
        match self {
            Self::Codex { .. } => ParserState::Codex(CodexState::default()),
            Self::ClaudeCode { .. } => ParserState::ClaudeCode(ClaudeCodeState::default()),
            Self::OpenCode { .. } => ParserState::OpenCode(OpenCodeState::default()),
            Self::Hermes { .. } => ParserState::Hermes(HermesState::default()),
        }
    }
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn hermes_home_dir() -> PathBuf {
    if let Some(val) = env::var_os("HERMES_HOME") {
        let s = val.to_string_lossy().trim().to_owned();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    home_dir().join(".hermes")
}

fn hermes_db_paths() -> Vec<PathBuf> {
    let home = hermes_home_dir();
    let mut out = Vec::new();
    let main = home.join("state.db");
    if main.is_file() {
        out.push(main);
    }
    let profiles = home.join("profiles");
    if let Ok(entries) = fs::read_dir(&profiles) {
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|k| k.is_dir()) {
                continue;
            }
            let candidate = entry.path().join("state.db");
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out
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
    lifecycle: FileLifecycle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileLifecycle {
    Priming,
    Live,
}

impl TrackedFile {
    fn new(metadata: &Metadata, parser: ParserState) -> Self {
        Self {
            identity: (metadata.dev(), metadata.ino()),
            offset: 0,
            partial: Vec::new(),
            discarding_oversized_line: false,
            parser,
            lifecycle: FileLifecycle::Priming,
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
    Hermes(HermesState),
}

impl ParserState {
    fn process_line(&mut self, line: &str) -> Option<NotificationEvent> {
        match self {
            Self::Codex(state) => state.process_line(line),
            Self::ClaudeCode(state) => state.process_line(line),
            Self::OpenCode(state) => state.process_line(line),
            Self::Hermes(state) => state.process_line(line),
        }
    }
}

#[derive(Debug, Default)]
struct CodexState {
    last_completed_turn_id: Option<String>,
    last_input_request_key: Option<String>,
    ignored: bool,
    ignored_turns: HashSet<String>,
}

impl CodexState {
    fn process_line(&mut self, line: &str) -> Option<NotificationEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return None;
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
            return None;
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
            return None;
        }

        let payload_type = payload.and_then(|p| p.get("type")).and_then(Value::as_str);
        let turn_id = payload
            .and_then(|p| p.get("turn_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if self.ignored
            || turn_id
                .as_ref()
                .is_some_and(|id| self.ignored_turns.contains(id))
        {
            return None;
        }

        if let Some(key) = Self::input_request_key(event_type, payload, line) {
            if self.last_input_request_key.as_ref() == Some(&key) {
                return None;
            }
            self.last_input_request_key = Some(key);
            return Some(NotificationEvent::Notification);
        }

        if event_type != Some("event_msg") || payload_type != Some("task_complete") {
            return None;
        }
        if turn_id
            .as_ref()
            .is_some_and(|id| self.last_completed_turn_id.as_ref() == Some(id))
        {
            return None;
        }
        self.last_completed_turn_id = turn_id;
        Some(NotificationEvent::Stop)
    }

    fn input_request_key(
        event_type: Option<&str>,
        payload: Option<&Value>,
        line: &str,
    ) -> Option<String> {
        let payload = payload?;
        let payload_type = payload.get("type").and_then(Value::as_str);
        let request_type = match (event_type, payload_type) {
            (
                Some("event_msg"),
                Some(
                    request_type @ ("exec_approval_request"
                    | "request_permissions"
                    | "request_user_input"
                    | "elicitation_request"
                    | "apply_patch_approval_request"),
                ),
            ) => request_type,
            (Some("response_item"), Some("function_call")) => match payload
                .get("name")
                .and_then(Value::as_str)
            {
                Some(request_type @ ("request_user_input" | "request_permissions")) => request_type,
                _ => return None,
            },
            _ => return None,
        };
        if request_type == "request_user_input" && Self::request_user_input_is_nonblocking(payload)
        {
            return None;
        }
        let request_id = ["approval_id", "call_id", "request_id", "id"]
            .into_iter()
            .find_map(|field| {
                payload.get(field).and_then(|value| match value {
                    Value::String(value) => Some(value.clone()),
                    Value::Number(value) => Some(value.to_string()),
                    _ => None,
                })
            });
        Some(format!(
            "{request_type}:{}",
            request_id.as_deref().unwrap_or(line)
        ))
    }

    fn request_user_input_is_nonblocking(payload: &Value) -> bool {
        payload.get("isBlocking").and_then(Value::as_bool) == Some(false)
            || payload
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
                .and_then(|arguments| arguments.get("isBlocking").and_then(Value::as_bool))
                == Some(false)
    }
}

#[derive(Debug, Default)]
struct ClaudeCodeState {
    last_completed_turn_id: Option<String>,
    last_input_request_key: Option<String>,
}

impl ClaudeCodeState {
    fn process_line(&mut self, line: &str) -> Option<NotificationEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            return None;
        }
        let turn_id = value.get("uuid").and_then(Value::as_str).map(str::to_owned);

        let question = value
            .pointer("/message/content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("type").and_then(Value::as_str) == Some("tool_use")
                        && item.get("name").and_then(Value::as_str) == Some("AskUserQuestion")
                })
            });
        if let Some(question) = question {
            let key = question
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| turn_id.clone())
                .unwrap_or_else(|| line.to_owned());
            if self.last_input_request_key.as_ref() == Some(&key) {
                return None;
            }
            self.last_input_request_key = Some(key);
            return Some(NotificationEvent::Notification);
        }

        if value
            .pointer("/message/stop_reason")
            .and_then(Value::as_str)
            != Some("end_turn")
        {
            return None;
        }
        if turn_id
            .as_ref()
            .is_some_and(|id| self.last_completed_turn_id.as_ref() == Some(id))
        {
            return None;
        }
        self.last_completed_turn_id = turn_id;
        Some(NotificationEvent::Stop)
    }
}

#[derive(Debug, Default)]
struct OpenCodeState {
    ignored_sessions: HashSet<String>,
    ignored_order: VecDeque<String>,
}

impl OpenCodeState {
    fn process_line(&mut self, line: &str) -> Option<NotificationEvent> {
        let message = read_field(line, "message");
        if message.as_deref() == Some("created") {
            let session_id = read_field(line, "id")?;
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
            return None;
        }
        if message.as_deref() != Some("exiting loop") {
            return None;
        }
        read_field(line, "session.id")
            .is_some_and(|id| !self.ignored_sessions.contains(&id))
            .then_some(NotificationEvent::Stop)
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

/// Hermes: state.db watcher
/// Read-only SQLite polling for ~/.hermes/state.db (+ profiles/*/state.db).
/// External observation only — never writes.
#[derive(Debug, Default)]
struct HermesState {}

impl HermesState {
    fn process_line(&mut self, _line: &str) -> Option<NotificationEvent> {
        None
    }
}

#[derive(Debug)]
struct HermesTracker {
    last_seen_id: Option<i64>,
}

impl HermesTracker {
    fn new() -> Self {
        Self { last_seen_id: None }
    }
}

#[derive(Debug)]
struct ClaudeSessionStatus {
    status: String,
    status_updated_at: i64,
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

fn is_hermes_clarify(tool_calls: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(tool_calls) else {
        return false;
    };
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| item.get("name").and_then(Value::as_str) == Some("clarify")),
        Value::Object(map) => map.get("name").and_then(Value::as_str) == Some("clarify"),
        _ => false,
    }
}

fn is_hermes_stop(finish_reason: &str, tool_calls: &str, content: &str) -> bool {
    if finish_reason != "stop" || content.trim().is_empty() {
        return false;
    }
    let trimmed = tool_calls.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    match value {
        Value::Array(ref items) => items.is_empty(),
        Value::Null => true,
        _ => false,
    }
}

pub struct LogMonitor {
    source: MonitorSource,
    tracked: HashMap<PathBuf, TrackedFile>,
    dispatcher: EventDispatcher,
    hermes: HashMap<PathBuf, HermesTracker>,
    claude_sessions: HashMap<PathBuf, ClaudeSessionStatus>,
    claude_sessions_primed: bool,
    claude_input_waits: HashMap<String, SystemTime>,
}

impl LogMonitor {
    pub fn new(
        source: MonitorSource,
        completion_delay: Duration,
        handler: NotificationHandler,
    ) -> Self {
        Self::with_dispatcher(source, EventDispatcher::new(completion_delay, handler))
    }

    fn with_dispatcher(source: MonitorSource, dispatcher: EventDispatcher) -> Self {
        let mut hermes = HashMap::new();
        if let MonitorSource::Hermes { db_paths } = &source {
            for p in db_paths {
                hermes.insert(p.clone(), HermesTracker::new());
            }
        }
        Self {
            source,
            tracked: HashMap::new(),
            dispatcher,
            hermes,
            claude_sessions: HashMap::new(),
            claude_sessions_primed: false,
            claude_input_waits: HashMap::new(),
        }
    }

    pub fn poll(&mut self, now: SystemTime) {
        if matches!(self.source, MonitorSource::Hermes { .. }) {
            self.poll_hermes();
            return;
        }
        let files = self.source.list_files(now);
        let active: HashSet<_> = files.iter().cloned().collect();
        for path in files {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            self.poll_file(&path, &metadata, now);
        }
        self.tracked
            .retain(|path, _| active.contains(path) && path.exists());
        self.poll_claude_sessions(now);
    }

    fn poll_file(&mut self, path: &Path, metadata: &Metadata, now: SystemTime) {
        let identity = (metadata.dev(), metadata.ino());
        let replaced = self
            .tracked
            .get(path)
            .is_some_and(|entry| entry.identity != identity || metadata.len() < entry.offset);
        if replaced || !self.tracked.contains_key(path) {
            self.tracked.insert(
                path.to_owned(),
                TrackedFile::new(metadata, self.source.new_state()),
            );
        }

        let entry = self.tracked.get_mut(path).expect("tracked file exists");
        let notify = entry.lifecycle == FileLifecycle::Live;
        if metadata.len() <= entry.offset {
            entry.lifecycle = FileLifecycle::Live;
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

        let mut completed = false;
        let mut input_waits = 0_usize;
        for line in lines {
            let line = String::from_utf8_lossy(&line);
            if line.trim().is_empty() {
                continue;
            }
            let event = entry.parser.process_line(&line);
            if !notify {
                continue;
            }
            match event {
                Some(NotificationEvent::Stop) => completed = true,
                Some(NotificationEvent::Notification) => input_waits += 1,
                None => {}
            }
        }
        if entry.offset >= metadata.len() {
            entry.lifecycle = FileLifecycle::Live;
        }
        for _ in 0..input_waits {
            if self.allow_input_wait_for_file(path, now) {
                self.dispatcher.dispatch(NotificationEvent::Notification);
            }
        }
        if completed {
            self.dispatcher.dispatch(NotificationEvent::Stop);
        }
    }

    fn allow_input_wait_for_file(&mut self, path: &Path, now: SystemTime) -> bool {
        if !matches!(self.source, MonitorSource::ClaudeCode { .. }) {
            return true;
        }
        let session_id = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.allow_claude_input_wait(&session_id, now)
    }

    fn allow_claude_input_wait(&mut self, session_id: &str, now: SystemTime) -> bool {
        self.claude_input_waits.retain(|_, at| {
            now.duration_since(*at)
                .is_ok_and(|elapsed| elapsed < CLAUDE_INPUT_WAIT_DEDUP_WINDOW)
        });
        if self.claude_input_waits.contains_key(session_id) {
            return false;
        }
        self.claude_input_waits.insert(session_id.to_owned(), now);
        true
    }

    fn poll_claude_sessions(&mut self, now: SystemTime) {
        let MonitorSource::ClaudeCode { sessions_dir, .. } = &self.source else {
            return;
        };
        let sessions_dir = sessions_dir.clone();
        let primed = std::mem::replace(&mut self.claude_sessions_primed, true);
        let Ok(entries) = fs::read_dir(&sessions_dir) else {
            self.claude_sessions.clear();
            return;
        };
        let mut seen = HashSet::new();
        let mut new_waits = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("kind").and_then(Value::as_str) != Some("interactive") {
                continue;
            }
            let Some(status) = value.get("status").and_then(Value::as_str) else {
                continue;
            };
            let status_updated_at = value
                .get("statusUpdatedAt")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map(|stem| stem.to_string_lossy().into_owned())
                        .unwrap_or_default()
                });
            seen.insert(path.clone());
            let previous = self.claude_sessions.insert(
                path,
                ClaudeSessionStatus {
                    status: status.to_owned(),
                    status_updated_at,
                },
            );
            if status != "waiting" {
                continue;
            }
            let entered_wait = match previous {
                Some(previous) => {
                    previous.status != "waiting" || previous.status_updated_at != status_updated_at
                }
                None => primed,
            };
            if entered_wait {
                new_waits.push(session_id);
            }
        }
        self.claude_sessions.retain(|path, _| seen.contains(path));
        for session_id in new_waits {
            if self.allow_claude_input_wait(&session_id, now) {
                self.dispatcher.dispatch(NotificationEvent::Notification);
            }
        }
    }

    fn poll_hermes(&mut self) {
        let paths: Vec<PathBuf> = self.hermes.keys().cloned().collect();
        let mut completed = false;
        let mut input_required = false;
        for db_path in paths {
            let tracker = self.hermes.get_mut(&db_path).expect("tracker exists");
            if fs::metadata(&db_path).is_err() {
                continue;
            }
            let uri = format!("file:{}?mode=ro&cache=shared", db_path.display());
            let conn = match rusqlite::Connection::open_with_flags(
                &uri,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
            ) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let _ = conn.busy_timeout(Duration::from_millis(HERMES_SQLITE_BUSY_TIMEOUT_MS as u64));
            let Some(last) = tracker.last_seen_id else {
                if let Ok(v) = conn.query_row("SELECT COALESCE(MAX(id),0) FROM messages", [], |r| {
                    r.get::<_, i64>(0)
                }) {
                    tracker.last_seen_id = Some(v);
                }
                continue;
            };
            let mut stmt = match conn.prepare("SELECT id, role, COALESCE(tool_calls,''), COALESCE(finish_reason,''), COALESCE(content,'') FROM messages WHERE id > ?1 ORDER BY id ASC LIMIT ?2") {
                Ok(s) => s,
                Err(_) => continue,
            };
            let rows = match stmt.query_map(
                rusqlite::params![last, HERMES_MAX_ROWS_PER_POLL as i64],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            ) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let mut max_id = last;
            for item in rows.flatten() {
                let (id, role, tool_calls, finish_reason, content) = item;
                if id > max_id {
                    max_id = id;
                }
                if role != "assistant" {
                    continue;
                }
                if is_hermes_clarify(&tool_calls) {
                    input_required = true;
                } else if is_hermes_stop(&finish_reason, &tool_calls, &content) {
                    completed = true;
                }
            }
            tracker.last_seen_id = Some(max_id);
        }
        if completed {
            self.dispatcher.dispatch(NotificationEvent::Stop);
        }
        if input_required {
            self.dispatcher.dispatch(NotificationEvent::Notification);
        }
    }
}

pub fn start_default_monitors(handler: NotificationHandler) {
    let dispatcher = EventDispatcher::new(DEFAULT_COMPLETION_DELAY, handler);
    for source in [
        MonitorSource::codex_default(),
        MonitorSource::claude_code_default(),
        MonitorSource::opencode_default(),
        MonitorSource::hermes_default(),
    ] {
        let dispatcher = dispatcher.clone();
        thread::spawn(move || {
            let mut monitor = LogMonitor::with_dispatcher(source, dispatcher);
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
    use std::sync::Mutex;
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

    fn counter() -> (Arc<AtomicUsize>, NotificationHandler) {
        let count = Arc::new(AtomicUsize::new(0));
        let target = Arc::clone(&count);
        let handler = Arc::new(move |_| {
            target.fetch_add(1, Ordering::SeqCst);
        });
        (count, handler)
    }

    fn event_log() -> (Arc<Mutex<Vec<NotificationEvent>>>, NotificationHandler) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&events);
        let handler = Arc::new(move |event| {
            target.lock().unwrap().push(event);
        });
        (events, handler)
    }

    fn event_counter() -> (Arc<AtomicUsize>, Arc<AtomicUsize>, NotificationHandler) {
        let completions = Arc::new(AtomicUsize::new(0));
        let input_requests = Arc::new(AtomicUsize::new(0));
        let completion_target = Arc::clone(&completions);
        let input_target = Arc::clone(&input_requests);
        let handler = Arc::new(move |event| match event {
            NotificationEvent::Stop => {
                completion_target.fetch_add(1, Ordering::SeqCst);
            }
            NotificationEvent::Notification => {
                input_target.fetch_add(1, Ordering::SeqCst);
            }
        });
        (completions, input_requests, handler)
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
    fn input_requests_are_dispatched_without_completion_delay() {
        let root = TempDir::new("codex-input");
        let dir = root.0.join("2026/04/24");
        create_dir_all(&dir).unwrap();
        let file = dir.join("rollout-session.jsonl");
        write(&file, "").unwrap();
        let (events, handler) = event_log();
        let mut monitor = LogMonitor::new(
            MonitorSource::Codex {
                sessions_dir: root.0.clone(),
            },
            Duration::from_secs(60),
            handler,
        );
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        let request = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"one\",\"arguments\":\"{\\\"questions\\\":[]}\"}}\n";
        append(&file, request);
        monitor.poll(now);
        append(&file, request);
        monitor.poll(now);

        assert_eq!(
            events.lock().unwrap().as_slice(),
            &[NotificationEvent::Notification]
        );
    }

    #[test]
    fn codex_deduplicates_and_ignores_internal_sessions() {
        let mut state = CodexState::default();
        assert_eq!(state.process_line("not-json"), None);
        assert_eq!(state.process_line("{\"type\":\"turn_context\",\"payload\":{\"model\":\"codex-auto-review\",\"turn_id\":\"review\"}}"), None);
        assert_eq!(state.process_line("{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"review\"}}"), None);
        assert_eq!(
            state.process_line(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
            ),
            Some(NotificationEvent::Stop)
        );
        assert_eq!(state.process_line(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
        ), None);

        let mut guardian = CodexState::default();
        assert_eq!(guardian.process_line("{\"type\":\"session_meta\",\"payload\":{\"source\":{\"subagent\":{\"other\":\"guardian\"}}}}"), None);
        assert_eq!(guardian.process_line(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"one\"}}"
        ), None);
    }

    #[test]
    fn codex_notifies_each_user_input_request_once() {
        let mut state = CodexState::default();
        for (index, event_type) in [
            "exec_approval_request",
            "request_permissions",
            "request_user_input",
            "elicitation_request",
            "apply_patch_approval_request",
        ]
        .into_iter()
        .enumerate()
        {
            let event = format!(
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{event_type}\",\"call_id\":\"call-{index}\"}}}}"
            );
            assert_eq!(
                state.process_line(&event),
                Some(NotificationEvent::Notification)
            );
            assert_eq!(state.process_line(&event), None);
        }

        let function_call = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"function-call\",\"arguments\":\"{\\\"questions\\\":[]}\"}}";
        assert_eq!(
            state.process_line(function_call),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(state.process_line(function_call), None);
        assert_eq!(
            state.process_line("{\"type\":\"event_msg\",\"payload\":{\"type\":\"request_user_input\",\"call_id\":\"non-blocking\",\"isBlocking\":false}}"),
            None
        );
        assert_eq!(
            state.process_line("{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"non-blocking-function-call\",\"arguments\":\"{\\\"questions\\\":[],\\\"isBlocking\\\":false}\"}}"),
            None
        );
        assert_eq!(
            state.process_line(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"elicitation_request\",\"id\":42}}"
            ),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(
            state.process_line(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"elicitation_request\",\"id\":42}}"
            ),
            None
        );
        assert_eq!(
            state.process_line("{\"type\":\"event_msg\",\"payload\":{\"type\":\"exec_approval_request\",\"call_id\":\"shared\",\"approval_id\":\"first\"}}"),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(
            state.process_line("{\"type\":\"event_msg\",\"payload\":{\"type\":\"exec_approval_request\",\"call_id\":\"shared\",\"approval_id\":\"second\"}}"),
            Some(NotificationEvent::Notification)
        );
    }

    #[test]
    fn missing_event_ids_do_not_suppress_completions() {
        let mut codex = CodexState::default();
        let codex_event = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}";
        assert_eq!(
            codex.process_line(codex_event),
            Some(NotificationEvent::Stop)
        );
        assert_eq!(
            codex.process_line(codex_event),
            Some(NotificationEvent::Stop)
        );

        let mut claude = ClaudeCodeState::default();
        let claude_event = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}";
        assert_eq!(
            claude.process_line(claude_event),
            Some(NotificationEvent::Stop)
        );
        assert_eq!(
            claude.process_line(claude_event),
            Some(NotificationEvent::Stop)
        );
    }

    #[test]
    fn claude_notifies_end_turn_once() {
        let mut state = ClaudeCodeState::default();
        assert_eq!(state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"tool_use\"}}"
        ), None);
        assert_eq!(state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}"
        ), Some(NotificationEvent::Stop));
        assert_eq!(state.process_line(
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}"
        ), None);
    }

    #[test]
    fn claude_notifies_each_ask_user_question_once() {
        let mut state = ClaudeCodeState::default();
        let question = "{\"type\":\"assistant\",\"uuid\":\"question-one\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\"}]}}";
        assert_eq!(
            state.process_line(question),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(state.process_line(question), None);
        assert_eq!(
            state.process_line("{\"type\":\"assistant\",\"uuid\":\"bash\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}"),
            None
        );

        let question_without_message_id = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-one\",\"name\":\"AskUserQuestion\"}]}}";
        assert_eq!(
            state.process_line(question_without_message_id),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(state.process_line(question_without_message_id), None);

        let question_without_ids = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\"}]}}";
        assert_eq!(
            state.process_line(question_without_ids),
            Some(NotificationEvent::Notification)
        );
        assert_eq!(state.process_line(question_without_ids), None);
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
        assert_eq!(
            state.process_line("id=child parentID=parent message=created"),
            None
        );
        assert_eq!(
            state.process_line("session.id=child message=\"exiting loop\""),
            None
        );
        assert_eq!(
            state.process_line("session.id=root message=\"exiting loop\""),
            Some(NotificationEvent::Stop)
        );
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
            assert_eq!(
                state.process_line(&format!("id=child-{index} parentID=parent message=created")),
                None
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
    fn files_discovered_after_startup_prime_existing_history() {
        let root = TempDir::new("late-file");
        let file = root.0.join("events.log");
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::OpenCode {
                log_path: file.clone(),
            },
            Duration::ZERO,
            handler,
        );

        monitor.poll(SystemTime::now());
        let mut history = b"message=\"exiting loop\" session.id=historical\n".to_vec();
        history.extend(vec![b'x'; MAX_BYTES_PER_POLL]);
        history.push(b'\n');
        write(&file, history).unwrap();
        monitor.poll(SystemTime::now());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(
            monitor.tracked.get(&file).unwrap().lifecycle,
            FileLifecycle::Priming
        );

        monitor.poll(SystemTime::now());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(
            monitor.tracked.get(&file).unwrap().lifecycle,
            FileLifecycle::Live
        );

        append(&file, "message=\"exiting loop\" session.id=new\n");
        monitor.poll(SystemTime::now());
        wait_for(&count, 1);
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
    fn completion_bursts_are_coalesced() {
        let root = TempDir::new("completion-burst");
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

        let records = (0..100)
            .map(|index| format!("message=\"exiting loop\" session.id=session-{index}\n"))
            .collect::<String>();
        append(&file, &records);
        monitor.poll(SystemTime::now());

        wait_for(&count, 1);
        thread::sleep(Duration::from_millis(30));
        assert_eq!(count.load(Ordering::SeqCst), 1);
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
                sessions_dir: root.0.join("sessions"),
            },
            Duration::from_millis(20),
            handler,
        );
        monitor.poll(SystemTime::now());
        let event = "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"end_turn\"}}\n";
        append(&file_a, event);
        append(&file_b, event);
        monitor.poll(SystemTime::now());
        wait_for(&count, 1);
        thread::sleep(Duration::from_millis(30));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    fn claude_session_json(session_id: &str, kind: &str, status: &str, updated_at: i64) -> String {
        format!(
            "{{\"pid\":100,\"sessionId\":\"{session_id}\",\"kind\":\"{kind}\",\"status\":\"{status}\",\"statusUpdatedAt\":{updated_at}}}"
        )
    }

    fn claude_monitor_with_sessions(
        name: &str,
    ) -> (
        TempDir,
        PathBuf,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        LogMonitor,
    ) {
        let root = TempDir::new(name);
        let sessions_dir = root.0.join("sessions");
        let projects_dir = root.0.join("projects");
        create_dir_all(&sessions_dir).unwrap();
        create_dir_all(&projects_dir).unwrap();
        let (completions, input_requests, handler) = event_counter();
        let monitor = LogMonitor::new(
            MonitorSource::ClaudeCode {
                projects_dir,
                sessions_dir: sessions_dir.clone(),
            },
            Duration::ZERO,
            handler,
        );
        (root, sessions_dir, completions, input_requests, monitor)
    }

    #[test]
    fn claude_sessions_notify_when_status_enters_waiting() {
        let (_root, sessions_dir, completions, input_requests, mut monitor) =
            claude_monitor_with_sessions("claude-sessions");
        let file = sessions_dir.join("100.json");
        write(
            &file,
            claude_session_json("session-a", "interactive", "busy", 1),
        )
        .unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 0);

        write(
            &file,
            claude_session_json("session-a", "interactive", "waiting", 2),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);

        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);

        write(
            &file,
            claude_session_json("session-a", "interactive", "shell", 3),
        )
        .unwrap();
        monitor.poll(now + Duration::from_secs(6));
        write(
            &file,
            claude_session_json("session-a", "interactive", "waiting", 4),
        )
        .unwrap();
        monitor.poll(now + Duration::from_secs(12));
        assert_eq!(input_requests.load(Ordering::SeqCst), 2);
        assert_eq!(completions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn claude_sessions_prime_existing_waits_without_notification() {
        let (_root, sessions_dir, _completions, input_requests, mut monitor) =
            claude_monitor_with_sessions("claude-sessions-prime");
        let file = sessions_dir.join("100.json");
        write(
            &file,
            claude_session_json("session-a", "interactive", "waiting", 1),
        )
        .unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 0);

        write(
            &file,
            claude_session_json("session-a", "interactive", "waiting", 2),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn claude_sessions_notify_new_sessions_already_waiting() {
        let (_root, sessions_dir, _completions, input_requests, mut monitor) =
            claude_monitor_with_sessions("claude-sessions-new");
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        write(
            sessions_dir.join("100.json"),
            claude_session_json("session-a", "interactive", "waiting", 1),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn claude_sessions_ignore_non_interactive_kinds() {
        let (_root, sessions_dir, _completions, input_requests, mut monitor) =
            claude_monitor_with_sessions("claude-sessions-kind");
        let file = sessions_dir.join("100.json");
        write(
            &file,
            claude_session_json("session-a", "background", "busy", 1),
        )
        .unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        write(
            &file,
            claude_session_json("session-a", "background", "waiting", 2),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn claude_transcript_and_session_waits_are_deduped_per_session() {
        let (root, sessions_dir, _completions, input_requests, mut monitor) =
            claude_monitor_with_sessions("claude-sessions-dedup");
        let project = root.0.join("projects/project");
        create_dir_all(&project).unwrap();
        let transcript = project.join("session-a.jsonl");
        write(&transcript, "").unwrap();
        let session_file = sessions_dir.join("100.json");
        write(
            &session_file,
            claude_session_json("session-a", "interactive", "busy", 1),
        )
        .unwrap();
        let now = UNIX_EPOCH + Duration::from_secs(1_777_075_200);

        monitor.poll(now);
        append(
            &transcript,
            "{\"type\":\"assistant\",\"uuid\":\"one\",\"message\":{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-one\",\"name\":\"AskUserQuestion\"}]}}\n",
        );
        write(
            &session_file,
            claude_session_json("session-a", "interactive", "waiting", 2),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);

        write(
            sessions_dir.join("101.json"),
            claude_session_json("session-b", "interactive", "waiting", 3),
        )
        .unwrap();
        monitor.poll(now);
        assert_eq!(input_requests.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn local_date_can_move_to_the_previous_day() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        assert_ne!(local_date(now, 0), local_date(now, 1));
    }

    #[test]
    fn hermes_detects_stop_and_clarify_rows() {
        assert!(is_hermes_clarify(
            r#"[{"name":"clarify","args":{"question":"?"}}]"#
        ));
        assert!(is_hermes_clarify(r#"{"name":"clarify"}"#));
        assert!(!is_hermes_clarify(r#"{"tool_calls":"clarify"}"#));
        assert!(!is_hermes_clarify(r#"[{"name":"read_file"}]"#));
        assert!(!is_hermes_clarify("not-json"));
        assert!(is_hermes_stop("stop", "", "done"));
        assert!(is_hermes_stop("stop", "[]", "done"));
        assert!(is_hermes_stop("stop", "null", "done"));
        assert!(!is_hermes_stop("tool_calls", "", "done"));
        assert!(!is_hermes_stop("stop", r#"[{"name":"clarify"}]"#, "done"));
        assert!(!is_hermes_stop("stop", "", "   "));
        assert!(!is_hermes_stop("stop", "not-json", "done"));
    }

    #[test]
    fn hermes_poll_reads_new_rows_without_writing() {
        // Integration: create a temp state.db, poll priming then new row.
        let dir = TempDir::new("hermes-db");
        let db_path = dir.0.join("state.db");
        // create minimal schema subset needed by poll_hermes
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, finish_reason TEXT, timestamp REAL);"
        ).unwrap();
        // historical row written before monitor starts — should be primed away
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["s1", "assistant", "old", "", "stop", 1.0],
        ).unwrap();
        drop(conn);
        let (completions, input_requests, handler) = event_counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::Hermes {
                db_paths: vec![db_path.clone()],
            },
            Duration::ZERO,
            handler,
        );
        // first poll primes — no notification for history
        monitor.poll(SystemTime::now());
        assert_eq!(completions.load(Ordering::SeqCst), 0);
        assert_eq!(input_requests.load(Ordering::SeqCst), 0);
        // append a new stop row
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["s1", "assistant", "done!", "", "stop", 2.0],
        ).unwrap();
        drop(conn);
        monitor.poll(SystemTime::now());
        wait_for(&completions, 1);
        assert_eq!(input_requests.load(Ordering::SeqCst), 0);
        // append a clarify row -> also notifies (coalesced)
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["s1", "assistant", "", r#"[{"name":"clarify"}]"#, "", 3.0],
        ).unwrap();
        drop(conn);
        monitor.poll(SystemTime::now());
        assert_eq!(completions.load(Ordering::SeqCst), 1);
        assert_eq!(input_requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hermes_prime_does_not_notify_even_with_clarify_history() {
        let dir = TempDir::new("hermes-prime");
        let db_path = dir.0.join("state.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, finish_reason TEXT, timestamp REAL);"
        ).unwrap();
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["s1", "assistant", "", r#"[{"name":"clarify"}]"#, "", 1.0],
        ).unwrap();
        conn.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, finish_reason, timestamp) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["s1", "assistant", "old stop", "", "stop", 2.0],
        ).unwrap();
        drop(conn);
        let (count, handler) = counter();
        let mut monitor = LogMonitor::new(
            MonitorSource::Hermes {
                db_paths: vec![db_path.clone()],
            },
            Duration::ZERO,
            handler,
        );
        monitor.poll(SystemTime::now());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(monitor.hermes.get(&db_path).unwrap().last_seen_id.is_some());
    }
}
