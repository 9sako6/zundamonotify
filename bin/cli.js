#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";
import { createClaudeCodeSessionsMonitor } from "../src/claude-code-monitor.js";
import { startServer } from "../src/server.js";
import {
  getLaunchAgentStatus,
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
    case undefined: {
      console.log(HELP);
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
      const status = getLaunchAgentStatus();
      if (!status.installed) {
        console.log("zundamonotify は自動起動に登録されていないのだ");
      } else if (status.running) {
        console.log("zundamonotify は自動起動に登録されていて、動いているのだ");
      } else {
        console.log("zundamonotify は自動起動に登録されているけど、動いていないのだ");
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
  await main();
}
