import { homedir } from "node:os";
import { resolve } from "node:path";
import { createJsonlMonitor } from "./jsonl-monitor.js";

const dataHome = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");

export const OPENCODE_LOG_PATH = resolve(dataHome, "opencode", "log", "opencode.log");
export const DEFAULT_OPENCODE_POLL_INTERVAL_MS = 1500;
export const DEFAULT_OPENCODE_COMPLETION_DELAY_MS = 2000;
const MAX_IGNORED_SESSIONS = 1024;

function readField(line, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = line.match(new RegExp(`(?:^| )${escapedName}=(?:"((?:\\\\.|[^"])*)"|([^ ]+))`));
  if (!match) return null;
  if (match[1] === undefined) return match[2];

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function createTrackedEntry() {
  return {
    offset: 0,
    partial: "",
    ignoredSessions: new Set(),
  };
}

function ignoreSession(entry, sessionId) {
  if (entry.ignoredSessions.has(sessionId)) return;
  if (entry.ignoredSessions.size >= MAX_IGNORED_SESSIONS) {
    entry.ignoredSessions.delete(entry.ignoredSessions.values().next().value);
  }
  entry.ignoredSessions.add(sessionId);
}

export function createOpenCodeLogMonitor({
  logPath = OPENCODE_LOG_PATH,
  pollIntervalMs = DEFAULT_OPENCODE_POLL_INTERVAL_MS,
  completionDelayMs = DEFAULT_OPENCODE_COMPLETION_DELAY_MS,
  onTaskComplete = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  function processLine(line, entry, notifyOnTaskComplete) {
    const message = readField(line, "message");

    if (message === "created") {
      const sessionId = readField(line, "id");
      if (!sessionId) return;

      const parentId = readField(line, "parentID");
      if (parentId !== null && parentId !== "undefined") {
        ignoreSession(entry, sessionId);
      } else {
        entry.ignoredSessions.delete(sessionId);
      }
      return;
    }

    if (message !== "exiting loop") return;

    const rawSessionId = readField(line, "session.id");
    if (!rawSessionId || entry.ignoredSessions.has(rawSessionId)) return;

    if (notifyOnTaskComplete) {
      notifyOnTaskComplete();
    }
  }

  return createJsonlMonitor({
    pollIntervalMs,
    completionDelayMs,
    onTaskComplete,
    schedule,
    cancel,
    createTrackedEntry,
    listFiles: () => [logPath],
    processLine,
  });
}
