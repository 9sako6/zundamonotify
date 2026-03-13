#!/usr/bin/env node

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { startServer } from "../src/server.js";
import { daemonize, stopDaemon } from "../src/daemon.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  pnpm start                 通知サーバーを起動するのだ（デフォルトなのだ）
  pnpm stop                  サーバーを止めるのだ
  pnpm hook                  ~/.claude/settings.json に hooks 設定を自動で書き込むのだ
  pnpm hook:show             hooks 設定の JSON を画面に出すだけなのだ（書き込まないのだ）

オプションなのだ:
  serve --port <number>      ポートを指定するのだ (デフォルト: 12378)
`.trim();

const SETTINGS_PATH = resolve(homedir(), ".claude", "settings.json");

function curlCommand(event) {
  return `curl -s --connect-timeout 1 -X POST http://host.docker.internal:12378/notifications/${event} || curl -s --connect-timeout 1 -X POST http://localhost:12378/notifications/${event}`;
}

function buildHookEntry(event) {
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

const HOOK_TYPES = ["Stop", "Notification"];

function hasZundamonotifyHook(entries, event) {
  return entries.some((entry) =>
    entry.hooks?.some((h) => h.command && h.command.includes(`12378/notifications/${event}`)),
  );
}

function writeSettingsFile() {
  let parsed = {};

  if (existsSync(SETTINGS_PATH)) {
    parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  }

  if (!parsed.hooks) parsed.hooks = {};

  let added = 0;
  for (const type of HOOK_TYPES) {
    const event = type.toLowerCase();
    if (!parsed.hooks[type]) parsed.hooks[type] = [];
    if (!hasZundamonotifyHook(parsed.hooks[type], event)) {
      parsed.hooks[type].push(buildHookEntry(event));
      added++;
    }
  }

  if (added === 0) {
    console.log("もう設定済みなのだ！スキップするのだ！");
    return;
  }

  mkdirSync(resolve(homedir(), ".claude"), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n");

  console.log(`設定を書き込んだのだ！: ${SETTINGS_PATH}`);
}

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
    if (process.env.ZUNDAMONOTIFY_CHILD) {
      startServer(port);
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
      writeSettingsFile();
    } else {
      const config = {
        hooks: Object.fromEntries(HOOK_TYPES.map((type) => [type, [buildHookEntry(type.toLowerCase())]])),
      };

      console.log();
      console.log("=== Claude Code の settings.json に以下を追加するのだ！ ===");
      console.log();
      console.log(JSON.stringify(config, null, 2));
      console.log();
      console.log("設定ファイルの場所はここなのだ:");
      console.log("  ~/.claude/settings.json");
      console.log();
      console.log("※ Devcontainer 内では host.docker.internal 経由で接続するのだ。");
      console.log("  ローカル環境では localhost にフォールバックするから安心なのだ！");
      console.log();
      console.log("💡 pnpm hook で自動書き込みできるのだ！");
      console.log();
    }
    break;
  }

  default:
    console.log(HELP);
    process.exitCode = command !== "--help" && command !== "-h" ? 1 : 0;
}
