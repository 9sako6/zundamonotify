#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";
import { startServer } from "../src/server.js";
import { daemonize, stopDaemon } from "../src/daemon.js";
import {
  CLAUDE_SETTINGS_PATH,
  buildClaudeHookConfig,
  writeClaudeSettingsFile,
} from "../src/claude-code-settings.js";
import { detectInstalledClients } from "../src/client-detection.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  pnpm start                 通知サーバーを起動するのだ（デフォルトなのだ）
  pnpm stop                  サーバーを止めるのだ
  pnpm hook                  Claude Code の設定を書くのだ
  pnpm hook:show             Claude Code の設定例を出すのだ

オプションなのだ:
  serve --port <number>      ポートを指定するのだ (デフォルト: 12378)
`.trim();

async function configureClients() {
  const installedClients = detectInstalledClients();
  if (installedClients.length === 0) {
    console.log("Claude Code が見つからなかったのだ……。先にインストールしてほしいのだ。");
    process.exitCode = 1;
    return;
  }

  const result = writeClaudeSettingsFile();
  if (result.status === "already") {
    console.log("Claude Code はもう設定済みなのだ！スキップするのだ！");
    return;
  }

  console.log(`Claude Code に設定を書き込んだのだ！: ${result.path}`);
}

function printConfigExamples() {
  const claudeConfig = buildClaudeHookConfig();

  console.log();
  console.log("=== Claude Code の settings.json に追加する内容なのだ ===");
  console.log();
  console.log(JSON.stringify(claudeConfig, null, 2));
  console.log();
  console.log(`設定ファイルの場所: ${CLAUDE_SETTINGS_PATH}`);
  console.log("※ Devcontainer 内では host.docker.internal を先に試すのだ。");
  console.log();
  console.log("💡 pnpm hook なら、自動で設定するのだ！");
  console.log();
}

function startCodexMonitor(port) {
  const monitor = createCodexSessionsMonitor({
    async onTaskComplete() {
      try {
        await fetch(`http://127.0.0.1:${port}/notifications/stop`, { method: "POST" });
      } catch {}
    },
  });
  return monitor.start();
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
          startCodexMonitor(activePort);
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

    case "init": {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          file: { type: "boolean", short: "f", default: false },
        },
      });

      if (values.file) {
        await configureClients();
      } else {
        printConfigExamples();
      }
      break;
    }

    default:
      console.log(HELP);
      process.exitCode = command !== "--help" && command !== "-h" ? 1 : 0;
  }
}

await main();
