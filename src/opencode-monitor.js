import { homedir } from "node:os";
import { resolve } from "node:path";
import { createJsonlMonitor } from "./jsonl-monitor.js";

const dataHome = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");

export const OPENCODE_LOG_PATH = resolve(dataHome, "opencode", "log", "opencode.log");
export const DEFAULT_OPENCODE_POLL_INTERVAL_MS = 1500;
export const DEFAULT_OPENCODE_COMPLETION_DELAY_MS = 2000;

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
    runs: new Map(),
    sessions: new Map(),
    completedTurns: new Set(),
  };
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
    const runId = readField(line, "run");
    const message = readField(line, "message");

    if (runId && message === "creating instance") {
      entry.runs.set(runId, readField(line, "directory") || "");
      return;
    }

    if (message === "created") {
      const sessionId = readField(line, "id");
      if (!sessionId) return;

      const parentId = readField(line, "parentID");
      const cwd = readField(line, "directory") || (runId && entry.runs.get(runId)) || "";
      entry.sessions.set(sessionId, {
        cwd,
        ignored: parentId !== null && parentId !== "undefined",
      });
      return;
    }

    if (message !== "exiting loop") return;

    const rawSessionId = readField(line, "session.id");
    const turnId = readField(line, "timestamp");
    if (!rawSessionId || !turnId) return;

    const session = entry.sessions.get(rawSessionId);
    if (session?.ignored) return;

    const completionKey = `${rawSessionId}:${turnId}`;
    if (entry.completedTurns.has(completionKey)) return;
    entry.completedTurns.add(completionKey);

    if (notifyOnTaskComplete) {
      notifyOnTaskComplete({
        sessionId: `opencode:${rawSessionId}`,
        cwd: session?.cwd || (runId && entry.runs.get(runId)) || "",
        turnId,
        lastAgentMessage: "",
      });
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
