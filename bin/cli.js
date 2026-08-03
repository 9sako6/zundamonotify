#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";
import { createClaudeCodeSessionsMonitor } from "../src/claude-code-monitor.js";
import { createOpenCodeLogMonitor } from "../src/opencode-monitor.js";
import { createNotifier, startServer } from "../src/server.js";
import { inspectLaunchAgent } from "../src/launchd.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  zundamonotify status       自動起動の状態を見るのだ

開発用なのだ:
  zundamonotify serve --port <number>  通知サーバーを前景で起動するのだ
`.trim();

function readPackageVersion() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return version;
}

const VERSION = process.env.ZUNDAMONOTIFY_VERSION || readPackageVersion();

function startMonitor(factory, onTaskComplete) {
  const monitor = factory({
    onTaskComplete,
  });
  return monitor.start();
}

function startCodexMonitor(onTaskComplete) {
  return startMonitor(createCodexSessionsMonitor, onTaskComplete);
}

function startClaudeCodeMonitor(onTaskComplete) {
  return startMonitor(createClaudeCodeSessionsMonitor, onTaskComplete);
}

function startOpenCodeMonitor(onTaskComplete) {
  return startMonitor(createOpenCodeLogMonitor, onTaskComplete);
}

export const MONITOR_STARTERS = [startCodexMonitor, startClaudeCodeMonitor, startOpenCodeMonitor];

export function startSessionMonitors(onTaskComplete, starters = MONITOR_STARTERS) {
  return starters.map((start) => start(onTaskComplete));
}

export function formatLaunchAgentStatus(status) {
  const detailLines = [
    `LaunchAgent: ${status.label}`,
    `通知サーバー: ${status.serverReachable ? "接続できるのだ" : "接続できないのだ"}`,
  ];

  if (status.ok) {
    return ["zundamonotify は自動起動に登録されていて、動いているのだ", ...detailLines];
  }

  const lines = ["zundamonotify は動いていないのだ", ...detailLines];
  if (status.issues.includes("server_unreachable")) {
    lines.push("⚠ 通知サーバーに接続できないのだ。起動直後か、再起動ループしている可能性があるのだ");
  }
  if (status.issues.includes("not_running")) {
    lines.push("⚠ launchd の job が起動していないのだ。nix-darwin の設定を確認してほしいのだ");
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
      const notify = createNotifier();
      const server = startServer(port, { notify });
      server.on("listening", () => {
        startSessionMonitors(() => notify("stop"));
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
