import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectLaunchAgent } from "../src/launchd.js";

describe("inspectLaunchAgent", () => {
  it("launchd と HTTP が正常なら ok なのだ", async () => {
    const calls = [];
    const status = await inspectLaunchAgent({
      target: "gui/501",
      probeServer: async () => true,
      runCommand(command, args) {
        calls.push([command, args]);
      },
    });

    assert.deepEqual(calls, [
      ["launchctl", ["print", "gui/501/com.9sako6.zundamonotify"]],
    ]);
    assert.equal(status.ok, true);
    assert.equal(status.running, true);
    assert.equal(status.serverReachable, true);
    assert.deepEqual(status.issues, []);
  });

  it("launchd の job がなければ not_running なのだ", async () => {
    let probed = false;
    const status = await inspectLaunchAgent({
      target: "gui/501",
      probeServer: async () => {
        probed = true;
        return true;
      },
      runCommand() {
        throw new Error("not loaded");
      },
    });

    assert.equal(status.ok, false);
    assert.equal(status.running, false);
    assert.equal(status.serverReachable, false);
    assert.equal(probed, false);
    assert.deepEqual(status.issues, ["not_running"]);
  });

  it("launchd が動いていても HTTP に届かなければ server_unreachable なのだ", async () => {
    const status = await inspectLaunchAgent({
      target: "gui/501",
      probeServer: async () => false,
      runCommand() {},
    });

    assert.equal(status.ok, false);
    assert.equal(status.running, true);
    assert.equal(status.serverReachable, false);
    assert.deepEqual(status.issues, ["server_unreachable"]);
  });
});
