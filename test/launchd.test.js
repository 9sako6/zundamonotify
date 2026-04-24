import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLaunchAgentPlist,
  getCurrentProgramArguments,
  getLaunchAgentStatus,
  inspectLaunchAgent,
  installLaunchAgent,
  uninstallLaunchAgent,
} from "../src/launchd.js";

let tmpRoot;

function makeTmpRoot() {
  tmpRoot = resolve(tmpdir(), `zundamonotify-launchd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("buildLaunchAgentPlist", () => {
  it("serve を起動する LaunchAgent plist を作るのだ", () => {
    const plist = buildLaunchAgentPlist({
      programArguments: ["/usr/local/bin/zundamonotify", "serve"],
      port: 12378,
    });

    assert.match(plist, /<key>Label<\/key>/);
    assert.match(plist, /com\.9sako6\.zundamonotify/);
    assert.match(plist, /<string>\/usr\/local\/bin\/zundamonotify<\/string>/);
    assert.match(plist, /<string>serve<\/string>/);
    assert.match(plist, /<string>--port<\/string>/);
    assert.match(plist, /<string>12378<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, /<key>KeepAlive<\/key>/);
    assert.match(plist, /<string>\/dev\/null<\/string>/);
  });

  it("XML として危ない文字をエスケープするのだ", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.example.<bad>&\"'",
      programArguments: ["/tmp/a&b", "serve"],
    });

    assert.match(plist, /com\.example\.&lt;bad&gt;&amp;&quot;&apos;/);
    assert.match(plist, /\/tmp\/a&amp;b/);
  });
});

describe("getCurrentProgramArguments", () => {
  it("Node 実行中は node と cli path と serve を返すのだ", () => {
    assert.deepEqual(
      getCurrentProgramArguments({
        execPath: "/usr/local/bin/node",
        scriptPath: "/repo/bin/cli.js",
      }),
      ["/usr/local/bin/node", "/repo/bin/cli.js", "serve"],
    );
  });

  it("単一バイナリ実行中は binary と serve だけ返すのだ", () => {
    assert.deepEqual(
      getCurrentProgramArguments({
        execPath: "/usr/local/bin/zundamonotify",
        scriptPath: "/usr/local/bin/zundamonotify",
      }),
      ["/usr/local/bin/zundamonotify", "serve"],
    );
  });

  it("Bun 単一バイナリの仮想 script path は LaunchAgent に入れないのだ", () => {
    assert.deepEqual(
      getCurrentProgramArguments({
        execPath: "/usr/local/bin/zundamonotify",
        scriptPath: "/$bunfs/root/zundamonotify-macos-arm64",
      }),
      ["/usr/local/bin/zundamonotify", "serve"],
    );
  });
});

describe("installLaunchAgent", () => {
  it("plist を書いて launchctl bootstrap するのだ", () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    const calls = [];

    const result = installLaunchAgent({
      plistPath,
      target: "gui/501",
      programArguments: ["/usr/local/bin/zundamonotify", "serve"],
      runCommand(command, args) {
        calls.push([command, args]);
      },
    });

    assert.equal(result.path, plistPath);
    assert.ok(existsSync(plistPath));
    assert.match(readFileSync(plistPath, "utf-8"), /zundamonotify/);
    assert.deepEqual(calls, [
      ["launchctl", ["bootout", "gui/501", plistPath]],
      ["launchctl", ["bootstrap", "gui/501", plistPath]],
    ]);
  });
});

describe("uninstallLaunchAgent", () => {
  it("launchctl bootout して plist を消すのだ", () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    const calls = [];
    mkdirSync(root, { recursive: true });
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      runCommand() {},
    });

    const result = uninstallLaunchAgent({
      plistPath,
      target: "gui/501",
      runCommand(command, args) {
        calls.push([command, args]);
      },
    });

    assert.equal(result.wasInstalled, true);
    assert.equal(existsSync(plistPath), false);
    assert.deepEqual(calls, [["launchctl", ["bootout", "gui/501", plistPath]]]);
  });
});

describe("getLaunchAgentStatus", () => {
  it("plist と launchctl print の結果から状態を返すのだ", () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      runCommand() {},
    });

    const status = getLaunchAgentStatus({
      plistPath,
      target: "gui/501",
      runCommand() {},
    });

    assert.equal(status.installed, true);
    assert.equal(status.running, true);
  });

  it("launchctl print が失敗したら running false を返すのだ", () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");

    const status = getLaunchAgentStatus({
      plistPath,
      target: "gui/501",
      runCommand() {
        throw new Error("not loaded");
      },
    });

    assert.equal(status.installed, false);
    assert.equal(status.running, false);
  });
});

describe("inspectLaunchAgent", () => {
  it("plist と launchd と HTTP が正常なら ok なのだ", async () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      programArguments: ["/usr/local/bin/zundamonotify", "serve"],
      runCommand() {},
    });

    const status = await inspectLaunchAgent({
      plistPath,
      target: "gui/501",
      currentProgramArguments: ["/usr/local/bin/zundamonotify", "serve"],
      probeServer: async () => true,
      runCommand() {},
    });

    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.running, true);
    assert.equal(status.serverReachable, true);
    assert.deepEqual(status.issues, []);
  });

  it("launchd が動いていても HTTP に届かなければ issue にするのだ", async () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      programArguments: ["/usr/local/bin/zundamonotify", "serve"],
      runCommand() {},
    });

    const status = await inspectLaunchAgent({
      plistPath,
      target: "gui/501",
      currentProgramArguments: ["/usr/local/bin/zundamonotify", "serve"],
      probeServer: async () => false,
      runCommand() {},
    });

    assert.equal(status.ok, false);
    assert.equal(status.running, true);
    assert.equal(status.serverReachable, false);
    assert.ok(status.issues.includes("server_unreachable"));
  });

  it("plist に Bun 仮想 path が混ざっていたら issue にするのだ", async () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      programArguments: [
        "/usr/local/bin/zundamonotify",
        "/$bunfs/root/zundamonotify-macos-arm64",
        "serve",
      ],
      runCommand() {},
    });

    const status = await inspectLaunchAgent({
      plistPath,
      target: "gui/501",
      currentProgramArguments: ["/usr/local/bin/zundamonotify", "serve"],
      probeServer: async () => true,
      runCommand() {},
    });

    assert.equal(status.ok, false);
    assert.ok(status.issues.includes("invalid_program_arguments"));
  });

  it("plist の binary が現在の binary と違っていたら issue にするのだ", async () => {
    const root = makeTmpRoot();
    const plistPath = resolve(root, "com.9sako6.zundamonotify.plist");
    installLaunchAgent({
      plistPath,
      target: "gui/501",
      programArguments: ["/old/zundamonotify", "serve"],
      runCommand() {},
    });

    const status = await inspectLaunchAgent({
      plistPath,
      target: "gui/501",
      currentProgramArguments: ["/new/zundamonotify", "serve"],
      probeServer: async () => true,
      runCommand() {},
    });

    assert.equal(status.ok, false);
    assert.ok(status.issues.includes("program_mismatch"));
  });
});
