import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNotifier, STOP_NOTIFICATION_DEDUP_MS } from "../src/notifier.js";

const FILES = {
  stop: ["/sounds/stop.wav"],
  notification: ["/sounds/notification.wav"],
};

describe("createNotifier", () => {
  it("イベントに対応する音声を afplay へ渡すのだ", () => {
    const calls = [];
    const notify = createNotifier({
      filesByEvent: FILES,
      run(command, args, done) {
        calls.push([command, args]);
        done(null);
      },
    });

    notify("notification");

    assert.deepEqual(calls, [["afplay", ["/sounds/notification.wav"]]]);
  });

  it("近接した stop 通知を抑制するのだ", () => {
    let nowMs = 1000;
    const calls = [];
    const notify = createNotifier({
      filesByEvent: FILES,
      now: () => nowMs,
      run(_command, _args, done) {
        calls.push("played");
        done(null);
      },
    });

    notify("stop");
    notify("stop");
    nowMs += STOP_NOTIFICATION_DEDUP_MS;
    notify("stop");

    assert.deepEqual(calls, ["played", "played"]);
  });

  it("再生中は別の afplay を起動しないのだ", () => {
    const calls = [];
    let finish;
    const notify = createNotifier({
      filesByEvent: FILES,
      run(_command, args, done) {
        calls.push(args[0]);
        finish = done;
      },
    });

    notify("notification");
    notify("notification");
    finish(null);
    notify("notification");

    assert.deepEqual(calls, ["/sounds/notification.wav", "/sounds/notification.wav"]);
  });

  it("音声がなければ警告して再生しないのだ", () => {
    const warnings = [];
    const notify = createNotifier({
      filesByEvent: { stop: [], notification: [] },
      warn: (message) => warnings.push(message),
      run() {
        assert.fail("afplayを起動してはいけないのだ");
      },
    });

    notify("notification");

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /notification/);
  });

  it("通常実行ではリポジトリの音声を使うのだ", () => {
    const calls = [];
    const notify = createNotifier({
      run(_command, args, done) {
        calls.push(args[0]);
        done(null);
      },
    });

    notify("stop");

    assert.equal(calls.length, 1);
    assert.match(calls[0], /assets[/\\]stop[/\\].*\.wav$/);
  });
});
