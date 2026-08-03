import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createOpenCodeLogMonitor } from "../src/opencode-monitor.js";

let logPath;

function runImmediately(fn) {
  fn();
  return {};
}

function makeLogFile() {
  logPath = resolve(tmpdir(), `zundamonotify-opencode-monitor-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(logPath, "");
  return logPath;
}

function line(fields) {
  return `${fields}\n`;
}

afterEach(() => {
  if (logPath) {
    rmSync(logPath, { force: true });
    logPath = undefined;
  }
});

describe("createOpenCodeLogMonitor", () => {
  it("起動後の exiting loop を完了として通知するのだ", () => {
    const filePath = makeLogFile();
    const events = [];
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete() {
        events.push("completed");
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      line('timestamp=2026-08-03T10:00:00.000Z level=INFO run=run-1 message="creating instance" directory="/work/my project"')
        + line('timestamp=2026-08-03T10:00:01.000Z level=INFO run=run-1 message=created id=ses_1 directory="/work/my project" parentID=undefined')
        + line('timestamp=2026-08-03T10:00:02.000Z level=INFO run=run-1 message="exiting loop" session.id=ses_1'),
    );
    monitor.poll();

    assert.deepEqual(events, ["completed"]);
  });

  it("起動直後の既存完了は通知しないのだ", () => {
    const filePath = makeLogFile();
    const events = [];
    appendFileSync(
      filePath,
      line("timestamp=2026-08-03T10:00:00.000Z level=INFO run=run-1 message=created id=ses_1 directory=/work/project parentID=undefined")
        + line('timestamp=2026-08-03T10:00:01.000Z level=INFO run=run-1 message="exiting loop" session.id=ses_1'),
    );
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete() {
        events.push("completed");
      },
    });

    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("tool loop の途中では通知しないのだ", () => {
    const filePath = makeLogFile();
    const events = [];
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete() {
        events.push("completed");
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      line("timestamp=2026-08-03T10:00:00.000Z level=INFO run=run-1 message=created id=ses_1 directory=/work/project parentID=undefined")
        + line("timestamp=2026-08-03T10:00:01.000Z level=INFO run=run-1 message=loop session.id=ses_1 step=1")
        + line("timestamp=2026-08-03T10:00:02.000Z level=INFO run=run-1 message=process session.id=ses_1 messageID=msg_1"),
    );
    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("parentID がある subagent session は通知しないのだ", () => {
    const filePath = makeLogFile();
    const events = [];
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete() {
        events.push("completed");
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      line("timestamp=2026-08-03T10:00:00.000Z level=INFO run=run-1 message=created id=ses_child directory=/work/project parentID=ses_parent")
        + line('timestamp=2026-08-03T10:00:01.000Z level=INFO run=run-1 message="exiting loop" session.id=ses_child'),
    );
    monitor.poll();

    assert.deepEqual(events, []);
  });

  it("同じ session の複数ターンをそれぞれ通知するのだ", () => {
    const filePath = makeLogFile();
    const events = [];
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
      onTaskComplete() {
        events.push("completed");
      },
    });

    monitor.poll();
    appendFileSync(
      filePath,
      line("timestamp=2026-08-03T10:00:00.000Z level=INFO run=run-1 message=created id=ses_1 directory=/work/project parentID=undefined")
        + line('timestamp=2026-08-03T10:00:01.000Z level=INFO run=run-1 message="exiting loop" session.id=ses_1')
        + line('timestamp=2026-08-03T10:01:01.000Z level=INFO run=run-1 message="exiting loop" session.id=ses_1'),
    );
    monitor.poll();

    assert.deepEqual(events, ["completed", "completed"]);
  });

  it("保持する subagent session は上限を超えないのだ", () => {
    const filePath = makeLogFile();
    const monitor = createOpenCodeLogMonitor({
      logPath: filePath,
      completionDelayMs: 0,
      schedule: runImmediately,
    });

    monitor.poll();
    appendFileSync(
      filePath,
      Array.from(
        { length: 1100 },
        (_, index) => line(`message=created id=ses_child_${index} parentID=ses_parent`),
      ).join(""),
    );
    monitor.poll();

    const entry = [...monitor.tracked.values()][0];
    assert.ok(entry.ignoredSessions.size <= 1024);
  });
});
