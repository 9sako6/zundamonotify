import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createJsonlMonitor } from "./jsonl-monitor.js";

export const CLAUDE_PROJECTS_PATH = resolve(homedir(), ".claude", "projects");
export const DEFAULT_CLAUDE_POLL_INTERVAL_MS = 1500;
export const DEFAULT_CLAUDE_COMPLETION_DELAY_MS = 2000;

function createTrackedEntry() {
  return {
    offset: 0,
    partial: "",
    lastCompletedTurnId: null,
  };
}

export function createClaudeCodeSessionsMonitor({
  projectsDir = CLAUDE_PROJECTS_PATH,
  pollIntervalMs = DEFAULT_CLAUDE_POLL_INTERVAL_MS,
  completionDelayMs = DEFAULT_CLAUDE_COMPLETION_DELAY_MS,
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

    if (parsed.type !== "assistant" || parsed.message?.stop_reason !== "end_turn") {
      return;
    }

    const turnId = parsed.uuid ?? null;
    if (turnId && turnId === entry.lastCompletedTurnId) {
      return;
    }

    entry.lastCompletedTurnId = turnId;
    if (notifyOnTaskComplete) {
      notifyOnTaskComplete();
    }
  }

  function listFiles() {
    const sessionFiles = [];
    let projectDirs;
    try {
      projectDirs = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      projectDirs = [];
    }

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      let files;
      try {
        files = readdirSync(join(projectsDir, projectDir.name), { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        sessionFiles.push(join(projectsDir, projectDir.name, file.name));
      }
    }

    return sessionFiles;
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
