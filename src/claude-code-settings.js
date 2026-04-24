import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const CLAUDE_SETTINGS_PATH = resolve(homedir(), ".claude", "settings.json");

const HOOK_TYPES = ["Stop", "Notification", "SubagentStop"];
const HOOK_EVENT_MAP = {
  Stop: "stop",
  Notification: "notification",
  SubagentStop: "notification",
};
const MARKER = ": zundamonotify ;";

export function curlCommand(event) {
  const prefix = "curl -s --connect-timeout 1 -X POST";
  return `${MARKER} ${prefix} http://host.docker.internal:12378/notifications/${event} || ${prefix} http://localhost:12378/notifications/${event}`;
}

export function buildClaudeHookEntry(event) {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: curlCommand(event),
      },
    ],
  };
}

export function buildClaudeHookConfig() {
  return {
    hooks: Object.fromEntries(
      HOOK_TYPES.map((type) => [type, [buildClaudeHookEntry(HOOK_EVENT_MAP[type])]]),
    ),
  };
}

function findZundamonotifyHookIndex(entries) {
  return entries.findIndex((entry) =>
    entry.hooks?.some((hook) => hook.command && hook.command.includes(MARKER)),
  );
}

function sameClaudeHookEntry(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function writeClaudeSettingsFile({
  settingsPath = CLAUDE_SETTINGS_PATH,
} = {}) {
  let parsed = {};

  if (existsSync(settingsPath)) {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  if (!parsed.hooks) parsed.hooks = {};

  let changed = 0;
  for (const type of HOOK_TYPES) {
    const event = HOOK_EVENT_MAP[type];
    if (!parsed.hooks[type]) parsed.hooks[type] = [];
    const nextEntry = buildClaudeHookEntry(event);
    const existingIndex = findZundamonotifyHookIndex(parsed.hooks[type]);

    if (existingIndex === -1) {
      parsed.hooks[type].push(nextEntry);
      changed++;
      continue;
    }

    if (!sameClaudeHookEntry(parsed.hooks[type][existingIndex], nextEntry)) {
      parsed.hooks[type][existingIndex] = nextEntry;
      changed++;
    }
  }

  if (changed === 0) {
    return { status: "already", path: settingsPath };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
  return { status: "updated", path: settingsPath, changed };
}
