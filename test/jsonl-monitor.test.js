import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlMonitor } from "../src/jsonl-monitor.js";

let tmpRoot;

function runImmediately(fn) {
  fn();
  return {};
}

function createMonitor(filePath, events) {
  return createJsonlMonitor({
    pollIntervalMs: 1000,
    completionDelayMs: 0,
    schedule: runImmediately,
    createTrackedEntry: () => ({ offset: 0, partial: "" }),
    listFiles: () => [filePath],
    processLine(line, _entry, notify) {
      if (notify) notify(line);
    },
    onTaskComplete(event) {
      events.push(event);
    },
  });
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("createJsonlMonitor のファイル世代管理", () => {
  it("ログが切り詰められたら既存内容を再通知せず追尾を再開するのだ", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zundamonotify-jsonl-monitor-"));
    const filePath = join(tmpRoot, "events.jsonl");
    const events = [];
    writeFileSync(filePath, "起動前の十分に長い履歴なのだ\n");
    const monitor = createMonitor(filePath, events);

    monitor.poll();
    appendFileSync(filePath, "最初の通知なのだ\n");
    monitor.poll();
    writeFileSync(filePath, "新世代の履歴なのだ\n");
    monitor.poll();
    appendFileSync(filePath, "切り詰め後の通知なのだ\n");
    monitor.poll();

    assert.deepEqual(events, ["最初の通知なのだ", "切り詰め後の通知なのだ"]);
  });

  it("同じパスのログが置換されたら新しいファイルとして追尾するのだ", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "zundamonotify-jsonl-monitor-"));
    const filePath = join(tmpRoot, "events.jsonl");
    const replacementPath = join(tmpRoot, "replacement.jsonl");
    const events = [];
    writeFileSync(filePath, "起動前なのだ\n");
    const monitor = createMonitor(filePath, events);

    monitor.poll();
    appendFileSync(filePath, "最初の通知なのだ\n");
    monitor.poll();
    writeFileSync(replacementPath, "置換時の履歴なのだ\n");
    renameSync(replacementPath, filePath);
    monitor.poll();
    appendFileSync(filePath, "置換後の通知なのだ\n");
    monitor.poll();

    assert.deepEqual(events, ["最初の通知なのだ", "置換後の通知なのだ"]);
  });
});
