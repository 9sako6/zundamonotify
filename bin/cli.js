#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { startServer } from "../src/server.js";
import { daemonize, stopDaemon } from "../src/daemon.js";
import {
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  DEFAULT_VOLUME_PERCENT,
  buildClaudeHookConfig,
  buildCodexNotifyConfig,
  detectInstalledClients,
  parseVolumePercent,
  writeClaudeSettingsFile,
  writeCodexConfigFile,
} from "../src/integrations.js";

const HELP = `
zundamonotify - ずんだもんの声でAIエージェントの完了をお知らせするのだ！

つかいかたなのだ:
  pnpm start                 通知サーバーを起動するのだ（デフォルトなのだ）
  pnpm stop                  サーバーを止めるのだ
  pnpm hook                  Claude Code / Codex の設定を対話式で書き込むのだ
  pnpm hook:show             Claude Code / Codex の設定例を100%音量で出すのだ

オプションなのだ:
  serve --port <number>      ポートを指定するのだ (デフォルト: 12378)
`.trim();

async function readAllFromStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
const CLIENT_ACTIONS = {
  claude(_prompter, { volumePercent }) {
    const result = writeClaudeSettingsFile({ volumePercent });
    if (result.status === "already") {
      console.log("Claude Code はもう設定済みなのだ！スキップするのだ！");
      return;
    }
    console.log(`Claude Code に設定を書き込んだのだ！: ${result.path} (${volumePercent}%)`);
  },

  async codex(prompter, { volumePercent }) {
    let result = writeCodexConfigFile({ volumePercent });

    if (result.status === "conflict") {
      const overwrite = await promptYesNo(
        prompter,
        "Codex の notify はもう別の設定があるのだ。ずんだもん用に上書きするのだ？ [y/N]: ",
        false,
      );
      if (!overwrite) {
        console.log("Codex の設定はそのままにしたのだ！");
        return;
      }
      result = writeCodexConfigFile({ overwrite: true, volumePercent });
    }

    if (result.status === "already") {
      console.log("Codex はもう設定済みなのだ！スキップするのだ！");
      return;
    }

    console.log(`Codex に設定を書き込んだのだ！: ${result.path} (${volumePercent}%)`);
  },
};

function createPrompter() {
  if (!process.stdin.isTTY) {
    return readAllFromStdin().then((input) => {
      const answers = input.split(/\r?\n/);
      let index = 0;

      return {
        async question(text) {
          process.stdout.write(text);
          return (answers[index++] ?? "").trim();
        },
        close() {},
      };
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return Promise.resolve({
    async question(text) {
      return (await rl.question(text)).trim();
    },
    close() {
      rl.close();
    },
  });
}

async function promptYesNo(prompter, question, defaultValue) {
  const answer = (await prompter.question(question)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

async function promptVolumePercent(prompter) {
  while (true) {
    const answer = await prompter.question(`音量を % で入れるのだ [${DEFAULT_VOLUME_PERCENT}]: `);
    if (!answer) return DEFAULT_VOLUME_PERCENT;

    const volumePercent = parseVolumePercent(answer);
    if (volumePercent !== null) {
      return volumePercent;
    }

    console.log("音量は 0 から 100 の数字で入れるのだ！");
  }
}

function buildSelectionOptions(installedClients) {
  const options = installedClients.map((client, index) => ({
    key: String(index + 1),
    label: client.label,
    clients: [client.id],
  }));

  if (installedClients.length > 1) {
    options.push({
      key: String(options.length + 1),
      label: "両方",
      clients: installedClients.map((client) => client.id),
    });
  }

  return options;
}

async function chooseClients(installedClients, prompter) {
  if (installedClients.length === 0) {
    console.log("Claude Code も Codex も見つからなかったのだ……。先にインストールしてほしいのだ。");
    process.exitCode = 1;
    return [];
  }

  const options = buildSelectionOptions(installedClients);
  const defaultKey = options.at(-1)?.key ?? "1";

  console.log("見つかったクライアントなのだ:");
  for (const client of installedClients) {
    console.log(`  - ${client.label}`);
  }
  console.log("");
  console.log("どれに設定するか選ぶのだ:");
  for (const option of options) {
    console.log(`  ${option.key}. ${option.label}`);
  }
  console.log("  0. 何もしない");

  const answer = await prompter.question(`番号を入れるのだ [${defaultKey}]: `);
  const selected = answer || defaultKey;
  if (selected === "0") {
    console.log("今回は何もしないのだ！");
    return [];
  }

  const option = options.find((candidate) => candidate.key === selected);
  if (!option) {
    console.log("その番号はわからないのだ……。今回は何もしないのだ。");
    process.exitCode = 1;
    return [];
  }

  return option.clients;
}

async function configureClients() {
  const installedClients = detectInstalledClients();
  const prompter = await createPrompter();

  try {
    const selectedClients = await chooseClients(installedClients, prompter);
    if (selectedClients.length === 0) return;

    const volumePercent = await promptVolumePercent(prompter);
    for (const clientId of selectedClients) {
      await CLIENT_ACTIONS[clientId](prompter, { volumePercent });
    }
  } finally {
    prompter.close();
  }
}

function printConfigExamples() {
  const claudeConfig = buildClaudeHookConfig({ volumePercent: DEFAULT_VOLUME_PERCENT });
  const codexConfig = buildCodexNotifyConfig({ volumePercent: DEFAULT_VOLUME_PERCENT });

  console.log();
  console.log("=== Claude Code の settings.json に追加する内容なのだ ===");
  console.log();
  console.log(JSON.stringify(claudeConfig, null, 2));
  console.log();
  console.log(`設定ファイルの場所: ${CLAUDE_SETTINGS_PATH}`);
  console.log("※ Devcontainer 内では host.docker.internal を先に試すのだ。");
  console.log();
  console.log("=== Codex の config.toml に追加する内容なのだ ===");
  console.log();
  console.log(codexConfig);
  console.log();
  console.log(`設定ファイルの場所: ${CODEX_CONFIG_PATH}`);
  console.log();
  console.log(`※ この例の音量は ${DEFAULT_VOLUME_PERCENT}% なのだ。`);
  console.log();
  console.log("💡 pnpm hook なら、入ってるクライアントを見つけて対話式で設定するのだ！");
  console.log();
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
