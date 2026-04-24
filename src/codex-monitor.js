import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const CODEX_SESSIONS_PATH = resolve(homedir(), ".codex", "sessions");
export const DEFAULT_CODEX_POLL_INTERVAL_MS = 1500;
export const DEFAULT_CODEX_COMPLETION_DELAY_MS = 2000;

export function getSessionDirs({ sessionDir = CODEX_SESSIONS_PATH, now = new Date() } = {}) {
  return [0, 1].map((daysAgo) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return join(sessionDir, year, month, day);
  });
}

export function extractSessionId(fileName) {
  const base = basename(fileName, ".jsonl");
  const parts = base.split("-");
  if (parts.length < 10) return null;
  return parts.slice(-5).join("-");
}

function createTrackedEntry(fileName) {
  const sessionId = extractSessionId(fileName);
  if (!sessionId) return null;

  return {
    offset: 0,
    sessionId: `codex:${sessionId}`,
    cwd: "",
    partial: "",
    lastCompletedTurnId: null,
  };
}

function readNewBytes(filePath, offset, size) {
  const fd = openSync(filePath, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export function createCodexSessionsMonitor({
  sessionDir = CODEX_SESSIONS_PATH,
  pollIntervalMs = DEFAULT_CODEX_POLL_INTERVAL_MS,
  completionDelayMs = DEFAULT_CODEX_COMPLETION_DELAY_MS,
  now = () => Date.now(),
  onTaskComplete = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const tracked = new Map();
  const pendingTimers = new Set();

  function processLine(line, entry, notifyOnTaskComplete) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const { type, payload } = parsed;
    if (type === "session_meta" && payload && typeof payload === "object") {
      entry.cwd = payload.cwd || "";
      return;
    }

    if (type !== "event_msg" || !payload || payload.type !== "task_complete") {
      return;
    }

    const turnId = payload.turn_id ?? null;
    if (turnId && turnId === entry.lastCompletedTurnId) {
      return;
    }

    entry.lastCompletedTurnId = turnId;
    if (!notifyOnTaskComplete) {
      return;
    }

    const event = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      turnId,
      lastAgentMessage: payload.last_agent_message || "",
    };
    let timer;
    let fired = false;
    timer = schedule(() => {
      fired = true;
      if (timer !== undefined) {
        pendingTimers.delete(timer);
      }
      onTaskComplete(event);
    }, completionDelayMs);
    if (!fired) {
      pendingTimers.add(timer);
    }
  }

  function pollFile(filePath, stat, notifyOnTaskComplete) {
    let entry = tracked.get(filePath);
    if (!entry) {
      entry = createTrackedEntry(filePath);
      if (!entry) return;
      tracked.set(filePath, entry);
    }

    if (stat.size <= entry.offset) return;

    const text = entry.partial + readNewBytes(filePath, entry.offset, stat.size);
    entry.offset = stat.size;
    const lines = text.split("\n");
    entry.partial = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      processLine(line, entry, notifyOnTaskComplete);
    }
  }

  function cleanStaleEntries(activeFiles) {
    for (const [filePath, entry] of tracked) {
      if (!existsSync(filePath) || !activeFiles.has(filePath)) {
        tracked.delete(filePath);
      }
    }
  }

  function poll() {
    const nowMs = now();
    const activeFiles = new Set();
    const notifyOnTaskComplete = hasPrimed;

    for (const dir of getSessionDirs({ sessionDir, now: new Date(nowMs) })) {
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }

      for (const fileName of files) {
        if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) continue;
        const filePath = join(dir, fileName);

        let stat;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }

        activeFiles.add(filePath);
        pollFile(filePath, stat, notifyOnTaskComplete);
      }
    }

    cleanStaleEntries(activeFiles);
    hasPrimed = true;
  }

  let hasPrimed = false;

  return {
    pollIntervalMs,
    tracked,
    poll,
    start() {
      poll();
      const timer = setInterval(poll, pollIntervalMs);
      return {
        stop() {
          clearInterval(timer);
          for (const pendingTimer of pendingTimers) {
            cancel(pendingTimer);
          }
          pendingTimers.clear();
        },
      };
    },
  };
}
