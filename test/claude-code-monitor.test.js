import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeCodeSessionsMonitor } from "../src/claude-code-monitor.js";

let tmpRoot;

function runImmediately(fn) {
  fn();
  return {};
}

function makeSessionFile({ project = "work-zundamonotify", sessionId = "session-1" } = {}) {
  tmpRoot = resolve(tmpdir(), `zundamonotify-claude-monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dir = resolve(tmpRoot, project);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${sessionId}.jsonl`);
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("createClaudeCodeSessionsMonitor", () => {
  it("起動後に追加された end_turn を検知して sessionId と cwd を渡すのだ", () => {
    const filePath = makeSessionFile({ sessionId: "abc-123" });
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          sessionId: "abc-123",
          message: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "done" }],
          },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, [
      {
        sessionId: "claude-code:abc-123",
        cwd: "/work/zundamonotify",
        turnId: "message-1",
        lastAgentMessage: "done",
      },
    ]);
  });

  it("tool_use は通知しないのだ", () => {
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: {
            stop_reason: "tool_use",
            content: [{ type: "text", text: "thinking" }],
          },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("同じ uuid は重複通知しないのだ", () => {
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
        }),
        JSON.stringify({
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done again" }] },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.equal(events.length, 1);
    assert.equal(events[0].turnId, "message-1");
  });

  it("起動直後の既存ファイルは再生しないのだ", () => {
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
        }),
        "",
      ].join("\n"),
    );

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("初回ポーリング後に追加されたイベントだけ通知するのだ", () => {
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "old" }] },
        }),
        "",
      ].join("\n"),
    );

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-2",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "new" }] },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events.map((event) => event.turnId), ["message-2"]);
  });

  it("subagents 配下のファイルは無視するのだ", () => {
    const filePath = makeSessionFile({ project: "work-zundamonotify" });
    const events = [];
    const subagentDir = resolve(tmpRoot, "work-zundamonotify", "session-1", "subagents");
    const subagentFile = resolve(subagentDir, "agent-1.jsonl");

    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(filePath, "");
    writeFileSync(
      subagentFile,
      [
        JSON.stringify({
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "subagent-message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "subagent" }] },
        }),
        "",
      ].join("\n"),
    );

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "main" }] },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.deepEqual(events.map((event) => event.turnId), ["message-1"]);
  });

  it("通知を completionDelayMs だけ遅らせるのだ", () => {
    const filePath = makeSessionFile();
    const events = [];
    const scheduled = [];

    writeFileSync(filePath, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 2000,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
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
    assert.equal(events[0].turnId, "message-1");
  });

  it("text ブロックがなければ lastAgentMessage は空文字なのだ", () => {
    const filePath = makeSessionFile();
    const events = [];

    writeFileSync(filePath, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: tmpRoot,
      completionDelayMs: 0,
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
          type: "assistant",
          cwd: "/work/zundamonotify",
          uuid: "message-1",
          message: {
            stop_reason: "end_turn",
            content: [{ type: "tool_use", name: "bash" }],
          },
        }),
        "",
      ].join("\n"),
    );
    monitor.poll();

    assert.equal(events.length, 1);
    assert.equal(events[0].lastAgentMessage, "");
  });

  it("複数プロジェクトを同時に監視するのだ", () => {
    const fileA = makeSessionFile({ project: "project-a", sessionId: "session-a" });
    const root = tmpRoot;
    const fileB = resolve(root, "project-b", "session-b.jsonl");
    const events = [];

    mkdirSync(resolve(root, "project-b"), { recursive: true });
    writeFileSync(fileA, "");
    writeFileSync(fileB, "");

    const monitor = createClaudeCodeSessionsMonitor({
      projectsDir: root,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete(event) {
        events.push(event);
      },
    });

    monitor.poll();
    appendFileSync(
      fileA,
      `${JSON.stringify({
        type: "assistant",
        cwd: "/work/project-a",
        uuid: "message-a",
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "A" }] },
      })}\n`,
    );
    appendFileSync(
      fileB,
      `${JSON.stringify({
        type: "assistant",
        cwd: "/work/project-b",
        uuid: "message-b",
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "B" }] },
      })}\n`,
    );
    monitor.poll();

    assert.deepEqual(
      events.map((event) => event.sessionId).sort(),
      ["claude-code:session-a", "claude-code:session-b"],
    );
  });
});
