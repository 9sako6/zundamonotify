import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { PID_FILE } from "../src/daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "cli.js");

/**
 * CLI を子プロセスで実行するヘルパーなのだ
 * env を渡すと環境変数を追加できるのだ
 */
function run(args, { env } = {}) {
  return runWithInput(args, { env });
}

function runWithInput(args, { env, stdin } = {}) {
  const childEnv = env ? { ...process.env, ...env } : process.env;

  if (stdin !== undefined) {
    return Promise.resolve().then(() => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        env: childEnv,
        input: stdin,
        encoding: "utf-8",
      });

      return {
        exitCode: result.status ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });
  }

  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: childEnv }, (err, stdout, stderr) => {
      resolve({
        exitCode: err?.code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function extractClaudeConfigJson(output) {
  const match = output.match(
    /=== Claude Code の settings\.json に追加する内容なのだ ===\n\n([\s\S]*?)\n\n設定ファイルの場所:/,
  );
  assert.ok(match, "Claude Code の JSON 設定が見つかるのだ");
  return match[1];
}

/**
 * テスト後にデーモンを掃除するヘルパーなのだ
 */
function cleanupDaemon() {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// --help なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify --help", () => {
  it("ヘルプを見せてくれて exit 0 で終わるのだ", async () => {
    const result = await run(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /zundamonotify/);
    assert.match(result.stdout, /serve/);
    assert.match(result.stdout, /hook/);
  });

  it("-h でも同じように見せてくれるのだ", async () => {
    const result = await run(["-h"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /zundamonotify/);
  });

  it("ヘルプに stop が載ってるのだ", async () => {
    const result = await run(["--help"]);
    assert.match(result.stdout, /stop/);
  });
});

// ---------------------------------------------------------------------------
// 引数なし → serve（デーモン起動）なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify (引数なしで呼んだのだ)", () => {
  afterEach(cleanupDaemon);

  it("引数なしでデーモンが起動するのだ", async () => {
    cleanupDaemon();
    const result = await run([]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /デーモンが起動したのだ/);
    assert.ok(existsSync(PID_FILE), "PID ファイルが作られてるのだ");
  });
});

// ---------------------------------------------------------------------------
// 知らないコマンドなのだ
// ---------------------------------------------------------------------------
describe("zundamonotify unknown", () => {
  it("知らないコマンドにはヘルプを出して exit 1 で怒るのだ", async () => {
    const result = await run(["unknown"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /つかいかたなのだ/);
  });
});

// ---------------------------------------------------------------------------
// init なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify init", () => {
  it("Claude Code と Codex の設定例をちゃんと出力するのだ", async () => {
    const result = await run(["init"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /settings\.json/);
    assert.match(result.stdout, /config\.toml/);
    assert.match(result.stdout, /Claude Code/);
    assert.match(result.stdout, /Codex/);
    assert.match(result.stdout, /"hooks"/);
    assert.match(result.stdout, /"Stop"/);
    assert.match(result.stdout, /"Notification"/);
    assert.match(result.stdout, /host\.docker\.internal/);
    assert.match(result.stdout, /localhost/);
    assert.match(result.stdout, /12378/);
    assert.match(result.stdout, /notifications\/stop/);
    assert.match(result.stdout, /notifications\/notification/);
    assert.match(result.stdout, /\\"volume\\":100/);
    assert.match(result.stdout, /notify = \[/);
    assert.match(result.stdout, /"sh", "-lc"/);
    assert.match(result.stdout, /host\.docker\.internal/);
  });

  it("出力に含まれる JSON はちゃんとパースできるのだ", async () => {
    const result = await run(["init"]);
    const parsed = JSON.parse(extractClaudeConfigJson(result.stdout));
    assert.ok(parsed.hooks.Stop);
    assert.ok(parsed.hooks.Notification);
    assert.equal(parsed.hooks.Stop[0].hooks[0].type, "command");
    assert.equal(parsed.hooks.Notification[0].hooks[0].type, "command");
  });

  it("curl コマンドに host.docker.internal → localhost のフォールバックがあるのだ", async () => {
    const result = await run(["init"]);
    const parsed = JSON.parse(extractClaudeConfigJson(result.stdout));
    const cmd = parsed.hooks.Stop[0].hooks[0].command;
    // host.docker.internal が先に来てるのだ
    const dockerIdx = cmd.indexOf("host.docker.internal");
    const localhostIdx = cmd.indexOf("localhost");
    assert.ok(dockerIdx < localhostIdx, "host.docker.internal が先に試行されるのだ");
    assert.match(cmd, /\|\|/, "|| でフォールバックしてるのだ");
    assert.match(cmd, /--connect-timeout/, "タイムアウト付きなのだ");
    assert.match(cmd, /Content-Type: application\/json/, "JSON で音量も送るのだ");
    assert.match(cmd, /"volume":100/, "デフォルト音量 100% を積んでるのだ");
    assert.match(cmd, /notifications\/stop/, "Stop イベントの URL なのだ");
  });

  it("pnpm hook のヒントが表示されるのだ", async () => {
    const result = await run(["init"]);
    assert.match(result.stdout, /pnpm hook/);
  });
});

// ---------------------------------------------------------------------------
// init -f なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify init -f", () => {
  let tmpHome;
  let settingsPath;
  let codexConfigPath;

  afterEach(() => {
    if (tmpHome && existsSync(tmpHome)) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  function setupTmpHome() {
    tmpHome = resolve(tmpdir(), `zundamonotify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(resolve(tmpHome, ".claude"), { recursive: true });
    mkdirSync(resolve(tmpHome, ".codex"), { recursive: true });
    settingsPath = resolve(tmpHome, ".claude", "settings.json");
    codexConfigPath = resolve(tmpHome, ".codex", "config.toml");
    return tmpHome;
  }

  it("Claude Code だけ見つかったときは settings.json を新規作成するのだ", async () => {
    const home = setupTmpHome();
    rmSync(settingsPath, { force: true });
    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Claude Code に設定を書き込んだのだ/);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(written.hooks.Stop);
    assert.equal(written.hooks.Stop.length, 1);
    assert.match(written.hooks.Stop[0].hooks[0].command, /12378\/notifications\/stop/);
    assert.match(written.hooks.Stop[0].hooks[0].command, /"volume":100/);
    assert.ok(written.hooks.Notification);
    assert.equal(written.hooks.Notification.length, 1);
    assert.match(written.hooks.Notification[0].hooks[0].command, /12378\/notifications\/notification/);
    assert.match(written.hooks.Notification[0].hooks[0].command, /"volume":100/);
  });

  it("既存の settings.json を壊さずフックを追記するのだ", async () => {
    const home = setupTmpHome();
    const existing = {
      hooks: {
        Notification: [{ matcher: "", hooks: [{ type: "command", command: "echo hi" }] }],
      },
      permissions: { allow: ["Read"] },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "1\n",
    });
    assert.equal(result.exitCode, 0);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // 既存の Notification hook が残ってるのだ
    assert.ok(written.hooks.Notification);
    assert.equal(written.hooks.Notification[0].hooks[0].command, "echo hi");
    // zundamonotify の Notification hook が追記されてるのだ
    assert.equal(written.hooks.Notification.length, 2);
    assert.match(written.hooks.Notification[1].hooks[0].command, /12378\/notifications\/notification/);
    // permissions も残ってるのだ
    assert.deepEqual(written.permissions, { allow: ["Read"] });
    // Stop フックが追加されてるのだ
    assert.ok(written.hooks.Stop);
    assert.equal(written.hooks.Stop.length, 1);
  });

  it("既に Stop に他のフックがある場合は壊さず追記するのだ", async () => {
    const home = setupTmpHome();
    const existing = {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo done" }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "1\n",
    });
    assert.equal(result.exitCode, 0);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(written.hooks.Stop.length, 2);
    assert.equal(written.hooks.Stop[0].hooks[0].command, "echo done");
    assert.match(written.hooks.Stop[1].hooks[0].command, /12378\/notifications\/stop/);
    // Notification も追加されてるのだ
    assert.ok(written.hooks.Notification);
    assert.equal(written.hooks.Notification.length, 1);
  });

  it("重複して追記しないのだ", async () => {
    const home = setupTmpHome();

    await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "1\n",
    });
    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "1\n",
    });
    assert.match(result.stdout, /Claude Code はもう設定済みなのだ/);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(written.hooks.Stop.length, 1);
    assert.equal(written.hooks.Notification.length, 1);
  });

  it("Claude Code の既存フックは音量変更で差し替えられるのだ", async () => {
    const home = setupTmpHome();

    await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "\n",
    });
    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude" },
      stdin: "1\n80\n",
    });
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /もう設定済みなのだ/);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(written.hooks.Stop.length, 1);
    assert.equal(written.hooks.Notification.length, 1);
    assert.match(written.hooks.Stop[0].hooks[0].command, /"volume":80/);
    assert.match(written.hooks.Notification[0].hooks[0].command, /"volume":80/);
  });

  it("Codex だけ見つかったときは config.toml に notify を書くのだ", async () => {
    const home = setupTmpHome();
    rmSync(codexConfigPath, { force: true });

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "codex" },
      stdin: "\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Codex に設定を書き込んだのだ/);

    const written = readFileSync(codexConfigPath, "utf-8");
    assert.match(written, /^notify = \[/m);
    assert.match(written, /"sh", "-lc"/);
    assert.match(written, /notifications\/stop/);
    assert.match(written, /"volume\\":100/);
  });

  it("両方見つかったときはまとめて設定できるのだ", async () => {
    const home = setupTmpHome();

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "claude,codex" },
      stdin: "3\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Claude Code に設定を書き込んだのだ/);
    assert.match(result.stdout, /Codex に設定を書き込んだのだ/);
    assert.ok(existsSync(settingsPath));
    assert.ok(existsSync(codexConfigPath));
  });

  it("Codex に既存 notify があるときは確認して上書きできるのだ", async () => {
    const home = setupTmpHome();
    writeFileSync(codexConfigPath, 'notify = ["echo", "old"]\n');

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "codex" },
      stdin: "1\n100\ny\n",
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /上書きするのだ/);

    const written = readFileSync(codexConfigPath, "utf-8");
    assert.match(written, /"sh", "-lc"/);
    assert.doesNotMatch(written, /"old"/);
  });

  it("Codex の音量も対話で変えられるのだ", async () => {
    const home = setupTmpHome();

    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "codex" },
      stdin: "\n65\n",
    });
    assert.equal(result.exitCode, 0);

    const written = readFileSync(codexConfigPath, "utf-8");
    assert.match(written, /"volume\\":65/);
  });

  it("対応クライアントが見つからないときは教えてくれるのだ", async () => {
    const home = setupTmpHome();
    const result = await runWithInput(["init", "-f"], {
      env: { HOME: home, ZUNDAMONOTIFY_AVAILABLE_CLIENTS: "" },
      stdin: "\n",
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /見つからなかったのだ/);
  });
});

// ---------------------------------------------------------------------------
// serve (フォアグラウンド: 環境変数で子プロセスとして起動) なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify serve (子プロセスモード)", () => {
  it("ZUNDAMONOTIFY_CHILD=1 でフォアグラウンドサーバーが起動するのだ", async () => {
    const proc = spawn(process.execPath, [CLI, "serve", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ZUNDAMONOTIFY_CHILD: "1" },
    });

    const output = await new Promise((resolve, reject) => {
      let data = "";
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("サーバー起動がタイムアウトしたのだ……"));
      }, 5000);

      proc.stdout.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("起動したのだ")) {
          clearTimeout(timeout);
          resolve(data);
        }
      });
    });

    assert.match(output, /ずんだもん通知サーバーが起動したのだ/);
    proc.kill();
  });
});

// ---------------------------------------------------------------------------
// serve (デーモンモード) なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify serve (デーモン)", () => {
  afterEach(cleanupDaemon);

  it("デーモンとして起動して PID ファイルが作られるのだ", async () => {
    const result = await run(["serve", "-p", "19876"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /デーモンが起動したのだ/);
    assert.match(result.stdout, /PID:/);
    assert.ok(existsSync(PID_FILE), "PID ファイルが作られてるのだ");
  });

  it("二重起動しようとしたら怒られるのだ", async () => {
    await run(["serve", "-p", "19877"]);
    const result = await run(["serve", "-p", "19877"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /もう起動してるのだ/);
  });
});

// ---------------------------------------------------------------------------
// stop なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify stop", () => {
  it("デーモンを起動して stop で止められるのだ", async () => {
    await run(["serve", "-p", "19878"]);
    await new Promise((r) => setTimeout(r, 200));
    const result = await run(["stop"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /止めたのだ/);
    assert.ok(!existsSync(PID_FILE), "PID ファイルが消えてるのだ");
  });

  it("動いてないときに stop しても優しく教えてくれるのだ", async () => {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    const result = await run(["stop"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /動いてないのだ/);
  });
});
