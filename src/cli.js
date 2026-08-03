import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClaudeCodeSessionsMonitor } from "./claude-code-monitor.js";
import { createCodexSessionsMonitor } from "./codex-monitor.js";
import { inspectLaunchAgent } from "./launchd.js";
import { createNotifier } from "./notifier.js";
import { createOpenCodeLogMonitor } from "./opencode-monitor.js";
import { startServer } from "./server.js";

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
  return factory({ onTaskComplete }).start();
}

export const MONITOR_STARTERS = [
  (onTaskComplete) => startMonitor(createCodexSessionsMonitor, onTaskComplete),
  (onTaskComplete) => startMonitor(createClaudeCodeSessionsMonitor, onTaskComplete),
  (onTaskComplete) => startMonitor(createOpenCodeLogMonitor, onTaskComplete),
];

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

export async function main({ filesByEvent } = {}) {
  const command = process.argv[2];

  switch (command) {
    case undefined:
      console.log(HELP);
      break;

    case "--version":
    case "-v":
      console.log(VERSION);
      break;

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
      const notify = createNotifier({ filesByEvent });
      const server = startServer(port, notify);
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
