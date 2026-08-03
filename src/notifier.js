import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");
export const STOP_NOTIFICATION_DEDUP_MS = 5000;

function listWavFiles(event) {
  const dir = resolve(ASSETS_DIR, event);
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".wav"))
      .map((file) => resolve(dir, file));
  } catch {
    return [];
  }
}

function loadAssetFiles() {
  return {
    stop: listWavFiles("stop"),
    notification: listWavFiles("notification"),
  };
}

export function createNotifier({
  filesByEvent = loadAssetFiles(),
  now = () => Date.now(),
  random = Math.random,
  run = execFile,
  warn = console.warn,
  reportError = console.error,
} = {}) {
  let lastStopAt;
  let playing = false;

  return function notify(event) {
    if (event === "stop") {
      const nowMs = now();
      if (lastStopAt !== undefined && nowMs - lastStopAt < STOP_NOTIFICATION_DEDUP_MS) return;
      lastStopAt = nowMs;
    }

    const files = filesByEvent[event] ?? [];
    if (files.length === 0) {
      warn(`⚠ ${event} の .wav ファイルが見つからないのだ！`);
      return;
    }
    if (playing) return;

    playing = true;
    const wavPath = files[Math.floor(random() * files.length)];
    run("afplay", [wavPath], (error) => {
      playing = false;
      if (error) {
        reportError("⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！:", error.message);
      }
    });
  };
}
