import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSessionMonitors } from "../bin/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "cli.js");

/**
 * CLI を子プロセスで実行するヘルパーなのだ
 * env を渡すと環境変数を追加できるのだ
 */
function run(args, { env } = {}) {
  const childEnv = env ? { ...process.env, ...env } : process.env;

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

// ---------------------------------------------------------------------------
// --help なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify --help", () => {
  it("ヘルプを見せてくれて exit 0 で終わるのだ", async () => {
    const result = await run(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /zundamonotify/);
    assert.match(result.stdout, /install/);
    assert.match(result.stdout, /uninstall/);
    assert.match(result.stdout, /status/);
    assert.match(result.stdout, /serve/);
  });

  it("-h でも同じように見せてくれるのだ", async () => {
    const result = await run(["-h"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /zundamonotify/);
  });

  it("ヘルプに status が載ってるのだ", async () => {
    const result = await run(["--help"]);
    assert.match(result.stdout, /status/);
  });
});

// ---------------------------------------------------------------------------
// 引数なし → help なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify (引数なしで呼んだのだ)", () => {
  it("引数なしでヘルプを表示するのだ", async () => {
    const result = await run([]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /つかいかたなのだ/);
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
// serve (フォアグラウンド: 環境変数で子プロセスとして起動) なのだ
// ---------------------------------------------------------------------------
describe("zundamonotify serve (ポートバリデーション)", () => {
  for (const badPort of ["abc", "99999", "3.14"]) {
    it(`不正なポート "${badPort}" はエラーになるのだ`, async () => {
      const result = await run(["serve", "--port", badPort], {
        env: {},
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /ポートは 0〜65535 の整数を指定するのだ/);
    });
  }
});

describe("zundamonotify serve (子プロセスモード)", () => {
  it("フォアグラウンドサーバーが起動するのだ", async () => {
    const proc = spawn(process.execPath, [CLI, "serve", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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

describe("startSessionMonitors", () => {
  it("登録された monitor starter を全部起動するのだ", () => {
    const calls = [];
    const handles = startSessionMonitors(12378, [
      (port) => {
        calls.push(["codex", port]);
        return { stop() {} };
      },
      (port) => {
        calls.push(["claude", port]);
        return { stop() {} };
      },
    ]);

    assert.deepEqual(calls, [
      ["codex", 12378],
      ["claude", 12378],
    ]);
    assert.equal(handles.length, 2);
  });
});
