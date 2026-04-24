import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCodexSessionsMonitor } from "../src/codex-monitor.js";

let tmpRoot;

function runImmediately(fn) {
  fn();
  return {};
}

function makeSessionFile({ isoDate = "2026-04-24T10:00:00.000Z" } = {}) {
  const date = new Date(isoDate);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  tmpRoot = resolve(tmpdir(), `zundamonotify-codex-monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dir = resolve(tmpRoot, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "rollout-2026-04-24T19-05-39-019dbef3-c4e5-70e1-9ac8-983162b6616b.jsonl");
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("createCodexSessionsMonitor", () => {
  it("起動後に追加された task_complete を検知して sessionId と cwd を渡すのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "session_meta",
          payload: { cwd: "/work/zundamonotify" },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, [
      {
        sessionId: "codex:019dbef3-c4e5-70e1-9ac8-983162b6616b",
        cwd: "/work/zundamonotify",
        turnId: "turn-1",
        lastAgentMessage: "done",
      },
    ]);
  });

  it("同じ turn_id は重複通知しないのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );

    monitor.poll();

    assert.equal(events.length, 1);
    assert.equal(events[0].turnId, "turn-1");
  });

  it("古いファイルの履歴は初回ポーリングで再生しないのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:10:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );
    utimesSync(filePath, new Date(nowMs - 180_000), new Date(nowMs - 180_000));

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("新しいファイルの履歴も起動直後には再生しないのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:30.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "session_meta",
          payload: { cwd: "/work/zundamonotify" },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();

    assert.deepEqual(events, []);

    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:31.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-2" },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events.map((event) => event.turnId), ["turn-2"]);
    assert.equal(events[0].cwd, "/work/zundamonotify");
  });

  it("task_complete の通知は少し遅らせるのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];
    const scheduled = [];

    writeFileSync(filePath, "");

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 2000,
      now: () => nowMs,
      schedule(fn, delay) {
        scheduled.push({ fn, delay });
        return { fn, delay };
      },
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, []);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 2000);

    scheduled[0].fn();

    assert.equal(events.length, 1);
    assert.equal(events[0].turnId, "turn-1");
  });

  it("アイドル後に同じ session file を先頭から再生しないのだ", () => {
    let nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    assert.deepEqual(events, []);

    nowMs += 360_000;
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:06:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-2" },
        }),
        "",
      ].join("\n"),
    );

    monitor.poll();

    assert.deepEqual(events.map((event) => event.turnId), ["turn-2"]);
  });

  it("guardian session の approval review 完了は通知しないのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "session_meta",
          payload: {
            cwd: "/work/zundamonotify",
            source: { subagent: { other: "guardian" } },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-guardian",
            last_agent_message: JSON.stringify({ outcome: "allow" }),
          },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("codex-auto-review の完了は通知しないのだ", () => {
    const nowMs = Date.parse("2026-04-24T10:00:00.000Z");
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createCodexSessionsMonitor({
      sessionDir: tmpRoot,
      completionDelayMs: 0,
      now: () => nowMs,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-04-24T10:00:00.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn-review",
            model: "codex-auto-review",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-24T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-review",
            last_agent_message: JSON.stringify({ outcome: "allow" }),
          },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, []);
  });
});
