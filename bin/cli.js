#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";
import { createClaudeCodeSessionsMonitor } from "../src/claude-code-monitor.js";
import { startServer } from "../src/server.js";
import {
  inspectLaunchAgent,
  installLaunchAgent,
  uninstallLaunchAgent,
} from "../src/launchd.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  zundamonotify install      ログイン時に自動起動するようにするのだ
  zundamonotify uninstall    自動起動を解除するのだ
  zundamonotify status       自動起動の状態を見るのだ

開発用なのだ:
  zundamonotify serve --port <number>  通知サーバーを前景で起動するのだ
`.trim();

function readPackageVersion() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return version;
}

const VERSION = process.env.ZUNDAMONOTIFY_VERSION || readPackageVersion();

export function createAgentEventNotifier(port, source) {
  return async function notifyAgentEvent(event = {}) {
    try {
      await fetch(`http://127.0.0.1:${port}/agent-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "agent_turn.completed",
          source,
          sessionId: event.sessionId,
          cwd: event.cwd,
          turnId: event.turnId,
          message: event.lastAgentMessage,
        }),
      });
    } catch {}
  };
}

function startMonitor(factory, port, source) {
  const monitor = factory({
    onTaskComplete: createAgentEventNotifier(port, source),
  });
  return monitor.start();
}

function startCodexMonitor(port) {
  return startMonitor(createCodexSessionsMonitor, port, "codex");
}

function startClaudeCodeMonitor(port) {
  return startMonitor(createClaudeCodeSessionsMonitor, port, "claude-code");
}

export const MONITOR_STARTERS = [startCodexMonitor, startClaudeCodeMonitor];

export function startSessionMonitors(port, starters = MONITOR_STARTERS) {
  return starters.map((start) => start(port));
}

export function formatLaunchAgentStatus(status) {
  if (!status.installed) {
    return ["zundamonotify は自動起動に登録されていないのだ"];
  }

  if (status.ok) {
    return ["zundamonotify は自動起動に登録されていて、動いているのだ"];
  }

  const lines = ["zundamonotify は自動起動に登録されているけど、動いていないのだ"];
  if (status.issues.includes("invalid_program_arguments")) {
    lines.push("⚠ LaunchAgent の起動引数が壊れているのだ。もう一度 install してほしいのだ");
  }
  if (status.issues.includes("server_unreachable")) {
    lines.push("⚠ 通知サーバーに接続できないのだ。起動直後か、再起動ループしている可能性があるのだ");
  }
  if (status.issues.includes("not_running")) {
    lines.push("⚠ launchd には登録されているけど、job が起動していないのだ");
  }
  return lines;
}

export async function main() {
  const command = process.argv[2];

  switch (command) {
    case undefined: {
      console.log(HELP);
      break;
    }

    case "--version":
    case "-v": {
      console.log(VERSION);
      break;
    }

    case "install": {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          port: { type: "string", short: "p", default: "12378" },
        },
      });
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error("⚠ ポートは 0〜65535 の整数を指定するのだ！");
        process.exitCode = 1;
        break;
      }
      const result = installLaunchAgent({ port });
      console.log(`zundamonotify を自動起動に登録したのだ: ${result.path}`);
      break;
    }

    case "uninstall": {
      const result = uninstallLaunchAgent();
      if (result.wasInstalled) {
        console.log("zundamonotify の自動起動を解除したのだ");
      } else {
        console.log("zundamonotify は自動起動に登録されていないのだ");
      }
      break;
    }

    case "status": {
      const status = await inspectLaunchAgent();
      for (const line of formatLaunchAgentStatus(status)) {
        console.log(line);
      }
      break;
    }

    case "serve": {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          port: { type: "string", short: "p", default: "12378" },
        },
      });
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error("⚠ ポートは 0〜65535 の整数を指定するのだ！");
        process.exitCode = 1;
        break;
      }
      const server = startServer(port);
      server.on("listening", () => {
        const address = server.address();
        const activePort = typeof address === "object" && address ? address.port : port;
        startSessionMonitors(activePort);
      });
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = command !== "--help" && command !== "-h" ? 1 : 0;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  if (process.env.ZUNDAMONOTIFY_BUN_ENTRY !== "1") {
    await main();
  }
}
