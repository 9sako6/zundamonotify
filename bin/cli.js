#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";
import { createClaudeCodeSessionsMonitor } from "../src/claude-code-monitor.js";
import { startServer } from "../src/server.js";
import { daemonize, stopDaemon } from "../src/daemon.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  pnpm start                 通知サーバーを起動するのだ（デフォルトなのだ）
  pnpm stop                  サーバーを止めるのだ

オプションなのだ:
  serve --port <number>      ポートを指定するのだ (デフォルト: 12378)
`.trim();

function createStopNotifier(port) {
  return async function notifyStop() {
    try {
      await fetch(`http://127.0.0.1:${port}/notifications/stop`, { method: "POST" });
    } catch {}
  };
}

function startMonitor(factory, port) {
  const monitor = factory({
    onTaskComplete: createStopNotifier(port),
  });
  return monitor.start();
}

function startCodexMonitor(port) {
  return startMonitor(createCodexSessionsMonitor, port);
}

function startClaudeCodeMonitor(port) {
  return startMonitor(createClaudeCodeSessionsMonitor, port);
}

export const MONITOR_STARTERS = [startCodexMonitor, startClaudeCodeMonitor];

export function startSessionMonitors(port, starters = MONITOR_STARTERS) {
  return starters.map((start) => start(port));
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "serve":
    case undefined: {
      const { values } = parseArgs({
        args: process.argv.slice(command === "serve" ? 3 : 2),
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
      if (process.env.ZUNDAMONOTIFY_CHILD) {
        const server = startServer(port);
        server.on("listening", () => {
          const address = server.address();
          const activePort = typeof address === "object" && address ? address.port : port;
          startSessionMonitors(activePort);
        });
      } else {
        daemonize(port);
      }
      break;
    }

    case "stop": {
      stopDaemon();
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
  await main();
}
