import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createJsonlMonitor } from "./jsonl-monitor.js";

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

export function createCodexSessionsMonitor({
  sessionDir = CODEX_SESSIONS_PATH,
  pollIntervalMs = DEFAULT_CODEX_POLL_INTERVAL_MS,
  completionDelayMs = DEFAULT_CODEX_COMPLETION_DELAY_MS,
  now = () => Date.now(),
  onTaskComplete = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
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
    if (notifyOnTaskComplete) {
      notifyOnTaskComplete({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        turnId,
        lastAgentMessage: payload.last_agent_message || "",
      });
    }
  }

  function listFiles() {
    const nowMs = now();
    const files = [];

    for (const dir of getSessionDirs({ sessionDir, now: new Date(nowMs) })) {
      let fileNames;
      try {
        fileNames = readdirSync(dir);
      } catch {
        continue;
      }

      for (const fileName of fileNames) {
        if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) continue;
        files.push(join(dir, fileName));
      }
    }

    return files;
  }

  return createJsonlMonitor({
    pollIntervalMs,
    completionDelayMs,
    onTaskComplete,
    schedule,
    cancel,
    createTrackedEntry,
    listFiles,
    processLine,
  });
}
