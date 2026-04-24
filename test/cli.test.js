import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentEventNotifier, formatLaunchAgentStatus, startSessionMonitors } from "../bin/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "cli.js");
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
);

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

describe("zundamonotify --version", () => {
  it("package version を表示するのだ", async () => {
    const result = await run(["--version"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), PACKAGE_VERSION);
  });

  it("-v でも package version を表示するのだ", async () => {
    const result = await run(["-v"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), PACKAGE_VERSION);
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

describe("formatLaunchAgentStatus", () => {
  it("正常なら動いていると表示するのだ", () => {
    assert.deepEqual(
      formatLaunchAgentStatus({
        installed: true,
        ok: true,
        path: "/Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        programArguments: ["/Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify"],
        serverReachable: true,
        issues: [],
      }),
      [
        "zundamonotify は自動起動に登録されていて、動いているのだ",
        "LaunchAgent: /Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        "Program: /Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify",
        "通知サーバー: 接続できるのだ",
      ],
    );
  });

  it("通知サーバーに届かなければ具体的に表示するのだ", () => {
    assert.deepEqual(
      formatLaunchAgentStatus({
        installed: true,
        ok: false,
        path: "/Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        programArguments: ["/Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify"],
        serverReachable: false,
        issues: ["server_unreachable"],
      }),
      [
        "zundamonotify は自動起動に登録されているけど、動いていないのだ",
        "LaunchAgent: /Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        "Program: /Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify",
        "通知サーバー: 接続できないのだ",
        "⚠ 通知サーバーに接続できないのだ。起動直後か、再起動ループしている可能性があるのだ",
      ],
    );
  });

  it("LaunchAgent の起動引数が壊れていたら再 install を促すのだ", () => {
    assert.deepEqual(
      formatLaunchAgentStatus({
        installed: true,
        ok: false,
        path: "/Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        programArguments: ["/Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify"],
        serverReachable: false,
        issues: ["invalid_program_arguments"],
      }),
      [
        "zundamonotify は自動起動に登録されているけど、動いていないのだ",
        "LaunchAgent: /Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        "Program: /Users/me/.local/share/mise/installs/zundamonotify/0.1.5/zundamonotify",
        "通知サーバー: 接続できないのだ",
        "⚠ LaunchAgent の起動引数が壊れているのだ。もう一度 install してほしいのだ",
      ],
    );
  });

  it("LaunchAgent が別の binary を見ていたら再 install を促すのだ", () => {
    assert.deepEqual(
      formatLaunchAgentStatus({
        installed: true,
        ok: false,
        path: "/Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        programArguments: ["/old/zundamonotify"],
        serverReachable: true,
        issues: ["program_mismatch"],
      }),
      [
        "zundamonotify は自動起動に登録されているけど、動いていないのだ",
        "LaunchAgent: /Users/me/Library/LaunchAgents/com.9sako6.zundamonotify.plist",
        "Program: /old/zundamonotify",
        "通知サーバー: 接続できるのだ",
        "⚠ LaunchAgent が今の zundamonotify と違うバイナリを見ているのだ。もう一度 install してほしいのだ",
      ],
    );
  });
});

describe("createAgentEventNotifier", () => {
  it("agent_turn.completed を /agent-events に POST するのだ", async () => {
    const requests = [];
    const server = createServer((req, res) => {
      let rawBody = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk) => {
        rawBody += chunk;
      });
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          body: JSON.parse(rawBody),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const notify = createAgentEventNotifier(port, "claude-code");
      await notify({
        sessionId: "claude-code:session-1",
        cwd: "/tmp/project",
        turnId: "turn-1",
        lastAgentMessage: "done",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/agent-events");
    assert.deepEqual(requests[0].body, {
      type: "agent_turn.completed",
      source: "claude-code",
      sessionId: "claude-code:session-1",
      cwd: "/tmp/project",
      turnId: "turn-1",
      message: "done",
    });
  });
});
