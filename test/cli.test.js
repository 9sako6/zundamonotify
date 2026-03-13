import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
  const opts = env ? { env: { ...process.env, ...env } } : {};
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], opts, (err, stdout, stderr) => {
      resolve({
        exitCode: err?.code ?? 0,
        stdout,
        stderr,
      });
    });
  });
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
  it("hooks 設定の JSON をちゃんと出力するのだ", async () => {
    const result = await run(["init"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /settings\.json/);
    assert.match(result.stdout, /"hooks"/);
    assert.match(result.stdout, /"Stop"/);
    assert.match(result.stdout, /"Notification"/);
    assert.match(result.stdout, /host\.docker\.internal/);
    assert.match(result.stdout, /localhost/);
    assert.match(result.stdout, /12378/);
    assert.match(result.stdout, /notifications\/stop/);
    assert.match(result.stdout, /notifications\/notification/);
  });

  it("出力に含まれる JSON はちゃんとパースできるのだ", async () => {
    const result = await run(["init"]);
    // JSON 部分を抽出するのだ (最初の { から最後の } まで)
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    assert.ok(jsonMatch, "JSON が出力に含まれてるのだ");
    const parsed = JSON.parse(jsonMatch[0]);
    assert.ok(parsed.hooks.Stop);
    assert.ok(parsed.hooks.Notification);
    assert.equal(parsed.hooks.Stop[0].hooks[0].type, "command");
    assert.equal(parsed.hooks.Notification[0].hooks[0].type, "command");
  });

  it("curl コマンドに host.docker.internal → localhost のフォールバックがあるのだ", async () => {
    const result = await run(["init"]);
    const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch[0]);
    const cmd = parsed.hooks.Stop[0].hooks[0].command;
    // host.docker.internal が先に来てるのだ
    const dockerIdx = cmd.indexOf("host.docker.internal");
    const localhostIdx = cmd.indexOf("localhost");
    assert.ok(dockerIdx < localhostIdx, "host.docker.internal が先に試行されるのだ");
    assert.match(cmd, /\|\|/, "|| でフォールバックしてるのだ");
    assert.match(cmd, /--connect-timeout/, "タイムアウト付きなのだ");
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

  afterEach(() => {
    if (tmpHome && existsSync(tmpHome)) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  function setupTmpHome() {
    tmpHome = resolve(tmpdir(), `zundamonotify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(resolve(tmpHome, ".claude"), { recursive: true });
    settingsPath = resolve(tmpHome, ".claude", "settings.json");
    return tmpHome;
  }

  it("settings.json が無い状態で新規作成するのだ", async () => {
    const home = setupTmpHome();
    // .claude ディレクトリだけ作って settings.json は無い状態にするのだ
    rmSync(settingsPath, { force: true });
    const result = await run(["init", "-f"], { env: { HOME: home } });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /書き込んだのだ/);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.ok(written.hooks.Stop);
    assert.equal(written.hooks.Stop.length, 1);
    assert.match(written.hooks.Stop[0].hooks[0].command, /12378\/notifications\/stop/);
    assert.ok(written.hooks.Notification);
    assert.equal(written.hooks.Notification.length, 1);
    assert.match(written.hooks.Notification[0].hooks[0].command, /12378\/notifications\/notification/);
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

    const result = await run(["init", "-f"], { env: { HOME: home } });
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

    const result = await run(["init", "-f"], { env: { HOME: home } });
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

    // 1回目
    await run(["init", "-f"], { env: { HOME: home } });
    // 2回目
    const result = await run(["init", "-f"], { env: { HOME: home } });
    assert.match(result.stdout, /もう設定済みなのだ/);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(written.hooks.Stop.length, 1);
    assert.equal(written.hooks.Notification.length, 1);
  });
});

// ---------------------------------------------------------------------------
// serve (フォアグラウンド: 環境変数で子プロセスとして起動) なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify serve (子プロセスモード)", () => {
  it("ZUNDAMONOTIFY_CHILD=1 でフォアグラウンドサーバーが起動するのだ", async () => {
    const proc = spawn("node", [CLI, "serve", "--port", "0"], {
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
