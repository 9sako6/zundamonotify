import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

async function request(port, method, path, init = {}) {
  const res = await fetch(`http://localhost:${port}${path}`, { method, ...init });
  const body = await res.json();
  return { status: res.status, body };
}

describe("HTTP Server なのだ", () => {
  const notifications = [];
  let server;
  let port;

  before(async () => {
    server = startServer(0, (event) => notifications.push(event));
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  beforeEach(() => {
    notifications.length = 0;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("GET /health で稼働確認できるのだ", async () => {
    const res = await request(port, "GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(notifications, []);
  });

  for (const event of ["stop", "notification"]) {
    it(`POST /notifications/${event} で通知するのだ`, async () => {
      const res = await request(port, "POST", `/notifications/${event}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(notifications, [event]);
    });
  }

  for (const [type, notification] of [
    ["agent_turn.completed", "stop"],
    ["alert.requested", "notification"],
  ]) {
    it(`POST /agent-events の ${type} を ${notification} 通知へ変換するのだ`, async () => {
      const res = await request(port, "POST", "/agent-events", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(notifications, [notification]);
    });
  }

  for (const type of ["unknown.happened", "approval_review.completed", "tool_call.completed"]) {
    it(`POST /agent-events の効果がない type ${type} は 400 なのだ`, async () => {
      const res = await request(port, "POST", "/agent-events", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });

      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: "Bad Request" });
      assert.deepEqual(notifications, []);
    });
  }

  it("不正なJSONは 400 なのだ", async () => {
    const res = await request(port, "POST", "/agent-events", {
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Bad Request" });
  });

  for (const [method, path] of [
    ["POST", "/notifications"],
    ["GET", "/notifications/stop"],
    ["POST", "/notifications/unknown"],
    ["GET", "/"],
  ]) {
    it(`${method} ${path} は 404 なのだ`, async () => {
      const res = await request(port, method, path);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "Not Found" });
    });
  }

  it("巨大なボディは 413 で拒否するのだ", async () => {
    const res = await request(port, "POST", "/notifications/stop", {
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(2048),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: "Payload Too Large" });
    assert.deepEqual(notifications, []);
  });

  it("通知endpointは制限内のボディを無視するのだ", async () => {
    const res = await request(port, "POST", "/notifications/stop", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(notifications, ["stop"]);
  });

  it("連続リクエストにもすべて応答するのだ", async () => {
    const results = await Promise.all([
      request(port, "POST", "/notifications/stop"),
      request(port, "POST", "/notifications/stop"),
      request(port, "POST", "/notifications/stop"),
    ]);
    assert.ok(results.every((res) => res.status === 200 && res.body.ok));
    assert.deepEqual(notifications, ["stop", "stop", "stop"]);
  });
});

describe("startServer の起動ログなのだ", () => {
  it("ポート 0 指定でも実際に bind したポートを表示するのだ", async () => {
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));

    const server = startServer(0, () => {});
    await new Promise((resolve) => server.on("listening", resolve));
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve) => server.close(resolve));
    console.log = originalLog;

    assert.notEqual(activePort, 0);
    assert.ok(logs.some((line) => line.includes(`http://localhost:${activePort}`)));
  });
});
