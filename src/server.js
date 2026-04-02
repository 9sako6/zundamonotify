import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VOLUME_PERCENT, parseVolumePercent } from "./integrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = resolve(__dirname, "..", "assets");

/** @internal テストから差し替えできるようにしてるのだ */
export const deps = { execFile };

const RES_OK = JSON.stringify({ ok: true });
const RES_NOT_FOUND = JSON.stringify({ error: "Not Found" });
const RES_PAYLOAD_TOO_LARGE = JSON.stringify({ error: "Payload Too Large" });
const MAX_BODY_BYTES = 1024;

let playing = false;

/**
 * 指定ディレクトリから .wav ファイル一覧を取得するのだ
 */
export function listWavFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".wav"))
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

/**
 * 配列からランダムに1つ選ぶのだ
 */
export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function volumePercentToPlayerValue(volumePercent = DEFAULT_VOLUME_PERCENT) {
  const normalized = parseVolumePercent(volumePercent) ?? DEFAULT_VOLUME_PERCENT;
  return String(Number((normalized / 100).toFixed(2)));
}

function parseNotificationPayload(rawBody) {
  if (!rawBody) return {};

  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function playSound(wavPath, volumePercent = DEFAULT_VOLUME_PERCENT) {
  if (playing) return;

  playing = true;
  deps.execFile("afplay", ["-v", volumePercentToPlayerValue(volumePercent), wavPath], (err) => {
    playing = false;
    if (err) {
      console.error("⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！:", err.message);
    }
  });
}

/**
 * イベント種別に応じたランダム音声を再生するのだ
 */
export function playSoundForEvent(event, { volumePercent = DEFAULT_VOLUME_PERCENT } = {}) {
  const dir = resolve(ASSETS_DIR, event === "notification" ? "notification" : "stop");
  const files = listWavFiles(dir);
  if (files.length === 0) {
    console.warn(`⚠ ${dir} に .wav ファイルが見つからないのだ！`);
    return;
  }
  playSound(pickRandom(files), volumePercent);
}

export function startServer(port) {
  const server = createServer((req, res) => {
    const match = req.method === "POST" && req.url?.match(/^\/notifications\/(stop|notification)$/);
    if (match) {
      const event = match[1];
      let rawBody = "";
      let aborted = false;
      req.setEncoding("utf-8");
      req.on("data", (chunk) => {
        rawBody += chunk;
        if (rawBody.length > MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(RES_PAYLOAD_TOO_LARGE);
          req.destroy();
        }
      });
      req.on("end", () => {
        if (aborted) return;
        const payload = parseNotificationPayload(rawBody);
        const volumePercent = parseVolumePercent(payload.volume) ?? DEFAULT_VOLUME_PERCENT;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(RES_OK);
        playSoundForEvent(event, { volumePercent });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(RES_NOT_FOUND);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`⚠ ポート ${port} はもう使われてるのだ！`);
    } else {
      console.error(`⚠ サーバーエラーなのだ！: ${err.message}`);
    }
    process.exitCode = 1;
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  server.listen(port, "127.0.0.1", () => {
    console.log(`ずんだもん通知サーバーが起動したのだ！ http://localhost:${port}`);
    console.log(`POST /notifications/stop         → 完了音声をランダム再生するのだ！`);
    console.log(`POST /notifications/notification  → 通知音声をランダム再生するのだ！`);

    const stopFiles = listWavFiles(resolve(ASSETS_DIR, "stop"));
    const notifFiles = listWavFiles(resolve(ASSETS_DIR, "notification"));
    console.log(`🔊 stop: ${stopFiles.length}本, notification: ${notifFiles.length}本 の音声があるのだ！`);

    if (stopFiles.length === 0 || notifFiles.length === 0) {
      console.warn("");
      console.warn("⚠ assets/stop/ または assets/notification/ に .wav ファイルが足りないのだ！");
    }
  });

  return server;
}
