import { constants, accessSync } from "node:fs";
import { delimiter, resolve } from "node:path";

const SUPPORTED_CLIENTS = [
  { id: "claude", label: "Claude Code", command: "claude" },
];

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
