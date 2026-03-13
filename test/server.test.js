import { describe, it, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startServer,
  playSound,
  playSoundForEvent,
  listWavFiles,
  pickRandom,
  ASSETS_DIR,
  deps,
} from "../src/server.js";

// afplay を実行させないように deps.execFile を差し替えるのだ
const execFileCalls = [];
deps.execFile = (cmd, cmdArgs, cb) => {
  execFileCalls.push([cmd, cmdArgs, cb]);
  cb(null);
};

/**
 * テスト用の HTTP リクエストヘルパーなのだ
 */
async function request(port, method, path) {
  const res = await fetch(`http://localhost:${port}${path}`, { method });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// HTTP エンドポイントのテストなのだ
// ---------------------------------------------------------------------------
describe("HTTP Server なのだ", () => {
  let server;
  let port;

  before(() => {
    server = startServer(0);
    port = server.address().port;
  });

  after(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  it("POST /notifications/stop したら 200 で { ok: true } が返ってくるのだ", async () => {
    const res = await request(port, "POST", "/notifications/stop");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("POST /notifications/notification したら 200 で { ok: true } が返ってくるのだ", async () => {
    const res = await request(port, "POST", "/notifications/notification");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it("POST /notifications（イベントなし）は 404 なのだ", async () => {
    const res = await request(port, "POST", "/notifications");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("GET /notifications/stop は 404 なのだ、POST じゃないとダメなのだ", async () => {
    const res = await request(port, "GET", "/notifications/stop");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("POST /notifications/unknown は 404 なのだ、知らないイベントなのだ", async () => {
    const res = await request(port, "POST", "/notifications/unknown");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("POST /other は 404 なのだ、パスが違うのだ", async () => {
    const res = await request(port, "POST", "/other");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("GET / は 404 なのだ、トップページはないのだ", async () => {
    const res = await request(port, "GET", "/");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("DELETE /notifications/stop は 404 なのだ、消しちゃダメなのだ", async () => {
    const res = await request(port, "DELETE", "/notifications/stop");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("PUT /notifications/stop は 404 なのだ、PUT もダメなのだ", async () => {
    const res = await request(port, "PUT", "/notifications/stop");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Not Found" });
  });

  it("POST /notifications/stop を連続で叩いても全部 200 なのだ、ずんだもんはタフなのだ", async () => {
    const results = await Promise.all([
      request(port, "POST", "/notifications/stop"),
      request(port, "POST", "/notifications/stop"),
      request(port, "POST", "/notifications/stop"),
    ]);
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    }
  });

  it("POST /notifications/stop にボディ付きで送っても 200 なのだ、寛容なのだ", async () => {
    const res = await fetch(`http://localhost:${port}/notifications/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "ずんだもんへのテスト通知なのだ" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });
});

// ---------------------------------------------------------------------------
// listWavFiles のテストなのだ
// ---------------------------------------------------------------------------
describe("listWavFiles なのだ", () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `zundamonotify-wavlist-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "a.wav"), "RIFF dummy");
    writeFileSync(join(tmpDir, "b.wav"), "RIFF dummy");
    writeFileSync(join(tmpDir, "c.txt"), "not a wav");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(".wav ファイルだけ返すのだ", () => {
    const files = listWavFiles(tmpDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith(".wav")));
  });

  it("存在しないディレクトリでも空配列を返すのだ", () => {
    const files = listWavFiles("/tmp/no-such-dir-zundamon");
    assert.deepEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// pickRandom のテストなのだ
// ---------------------------------------------------------------------------
describe("pickRandom なのだ", () => {
  it("配列から1つ選ぶのだ", () => {
    const arr = ["a", "b", "c"];
    const result = pickRandom(arr);
    assert.ok(arr.includes(result));
  });
});

// ---------------------------------------------------------------------------
// playSound のテストなのだ
// ---------------------------------------------------------------------------
describe("playSound なのだ", () => {
  it("WAV ファイルのパスを afplay に渡して再生するのだ", () => {
    const tmpWav = join(tmpdir(), "zundamonotify-test.wav");
    writeFileSync(tmpWav, "RIFF dummy");

    const before = execFileCalls.length;
    playSound(tmpWav);

    assert.equal(execFileCalls.length, before + 1);
    const [cmd, args] = execFileCalls.at(-1);
    assert.equal(cmd, "afplay");
    assert.deepEqual(args, [tmpWav]);

    unlinkSync(tmpWav);
  });

  it("再生中は重複して afplay を起動しないのだ", () => {
    // コールバックを呼ばないモックに一時的に差し替えるのだ
    const originalExecFile = deps.execFile;
    deps.execFile = (cmd, cmdArgs, cb) => {
      execFileCalls.push([cmd, cmdArgs, cb]);
      // コールバックを呼ばない = 再生中のままなのだ
    };

    const tmpWav = join(tmpdir(), "zundamonotify-test2.wav");
    writeFileSync(tmpWav, "RIFF dummy");

    const before = execFileCalls.length;
    playSound(tmpWav);
    playSound(tmpWav);
    assert.equal(execFileCalls.length, before + 1, "2回目は無視されるのだ");

    // playing フラグをリセットするのだ
    const cb = execFileCalls.at(-1)[2];
    cb(null);
    deps.execFile = originalExecFile;

    unlinkSync(tmpWav);
  });
});

// ---------------------------------------------------------------------------
// playSoundForEvent のテストなのだ
// ---------------------------------------------------------------------------
describe("playSoundForEvent なのだ", () => {
  it("stop イベントで assets/stop/ の wav を再生するのだ", () => {
    const before = execFileCalls.length;
    playSoundForEvent("stop");
    assert.equal(execFileCalls.length, before + 1);
    const [cmd, args] = execFileCalls.at(-1);
    assert.equal(cmd, "afplay");
    assert.match(args[0], /assets[/\\]stop[/\\].*\.wav$/);
  });

  it("notification イベントで assets/notification/ の wav を再生するのだ", () => {
    const before = execFileCalls.length;
    playSoundForEvent("notification");
    assert.equal(execFileCalls.length, before + 1);
    const [cmd, args] = execFileCalls.at(-1);
    assert.equal(cmd, "afplay");
    assert.match(args[0], /assets[/\\]notification[/\\].*\.wav$/);
  });

  it("ASSETS_DIR はプロジェクトの assets/ を指してるのだ", () => {
    assert.match(ASSETS_DIR, /assets$/);
  });
});
