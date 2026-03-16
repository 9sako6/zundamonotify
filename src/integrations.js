import { constants, accessSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";

export const CLAUDE_SETTINGS_PATH = resolve(homedir(), ".claude", "settings.json");
export const CODEX_CONFIG_PATH = resolve(homedir(), ".codex", "config.toml");
const HOOK_TYPES = ["Stop", "Notification"];
const SUPPORTED_CLIENTS = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
];

export function curlCommand(event) {
  return `curl -s --connect-timeout 1 -X POST http://host.docker.internal:12378/notifications/${event} || curl -s --connect-timeout 1 -X POST http://localhost:12378/notifications/${event}`;
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
    hooks: Object.fromEntries(HOOK_TYPES.map((type) => [type, [buildClaudeHookEntry(type.toLowerCase())]])),
  };
}

export function hasZundamonotifyHook(entries, event) {
  return entries.some((entry) =>
    entry.hooks?.some((hook) => hook.command && hook.command.includes(`12378/notifications/${event}`)),
  );
}

export function writeClaudeSettingsFile(settingsPath = CLAUDE_SETTINGS_PATH) {
  let parsed = {};

  if (existsSync(settingsPath)) {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  if (!parsed.hooks) parsed.hooks = {};

  let added = 0;
  for (const type of HOOK_TYPES) {
    const event = type.toLowerCase();
    if (!parsed.hooks[type]) parsed.hooks[type] = [];
    if (!hasZundamonotifyHook(parsed.hooks[type], event)) {
      parsed.hooks[type].push(buildClaudeHookEntry(event));
      added++;
    }
  }

  if (added === 0) {
    return { status: "already", path: settingsPath };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
  return { status: "updated", path: settingsPath, added };
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandPath(command, pathValue = process.env.PATH ?? "") {
  for (const baseDir of pathValue.split(delimiter)) {
    if (!baseDir) continue;
    const candidate = resolve(baseDir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function detectInstalledClients({
  pathValue = process.env.PATH ?? "",
  override = process.env.ZUNDAMONOTIFY_AVAILABLE_CLIENTS,
} = {}) {
  if (override !== undefined) {
    const forced = new Set(
      override
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    return SUPPORTED_CLIENTS.filter((client) => forced.has(client.id));
  }

  return SUPPORTED_CLIENTS.filter((client) => resolveCommandPath(client.command, pathValue));
}

function escapeTomlBasicString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function buildCodexNotifyCommand() {
  return ["sh", "-lc", curlCommand("stop")];
}

export function buildCodexNotifyLine() {
  const items = buildCodexNotifyCommand().map((value) => `"${escapeTomlBasicString(value)}"`);
  return `notify = [${items.join(", ")}]`;
}

function splitTomlRoot(text) {
  const match = text.match(/^\s*\[/m);
  if (!match) {
    return { root: text, rest: "" };
  }

  return {
    root: text.slice(0, match.index),
    rest: text.slice(match.index),
  };
}

function findTopLevelNotifyRange(rootText) {
  const match = rootText.match(/^[ \t]*notify[ \t]*=/m);
  if (!match || match.index === undefined) return null;

  const start = match.index;
  let cursor = start + match[0].length;
  let depth = 0;
  let inString = false;
  let escaping = false;
  let sawArray = false;

  while (cursor < rootText.length) {
    const char = rootText[cursor];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      cursor++;
      continue;
    }

    if (char === "\"") {
      inString = true;
      cursor++;
      continue;
    }

    if (char === "[") {
      depth++;
      sawArray = true;
      cursor++;
      continue;
    }

    if (char === "]") {
      depth = Math.max(0, depth - 1);
      cursor++;
      continue;
    }

    if (char === "\n" && (!sawArray || depth === 0)) {
      cursor++;
      break;
    }

    cursor++;
  }

  return { start, end: cursor };
}

function parseTomlStringArray(text) {
  const values = [];
  const matches = text.matchAll(/"((?:\\.|[^"])*)"/g);
  for (const match of matches) {
    values.push(match[1].replaceAll("\\\"", "\"").replaceAll("\\\\", "\\"));
  }
  return values;
}

function sameCommand(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function buildCodexNotifyConfig() {
  return buildCodexNotifyLine();
}

export function writeCodexConfigFile({
  configPath = CODEX_CONFIG_PATH,
  overwrite = false,
} = {}) {
  const desiredCommand = buildCodexNotifyCommand();
  const desiredLine = buildCodexNotifyLine();
  const current = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const { root, rest } = splitTomlRoot(current);
  const range = findTopLevelNotifyRange(root);

  if (range) {
    const currentBlock = root.slice(range.start, range.end);
    const currentCommand = parseTomlStringArray(currentBlock);

    if (sameCommand(currentCommand, desiredCommand)) {
      return { status: "already", path: configPath };
    }

    if (!overwrite) {
      return { status: "conflict", path: configPath, currentCommand };
    }

    const before = root.slice(0, range.start);
    const after = root.slice(range.end);
    const nextRoot = `${before}${desiredLine}\n${after.replace(/^\n*/, "")}`;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${nextRoot}${rest}`);
    return { status: "updated", path: configPath, replaced: true };
  }

  const prefix = root && !root.endsWith("\n") ? `${root}\n` : root;
  const nextRoot = `${prefix}${desiredLine}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${nextRoot}${rest}`);
  return { status: "updated", path: configPath, replaced: false };
}
