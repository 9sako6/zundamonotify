import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = resolve(__dirname, "..", "assets");
export const NOTIFICATION_EVENTS = ["stop", "notification"];
export const AGENT_EVENT_TYPES = [
  "agent_turn.completed",
  "approval_review.completed",
  "tool_call.completed",
  "alert.requested",
];
const EVENT_PATH_PATTERN = new RegExp(`^/notifications/(${NOTIFICATION_EVENTS.join("|")})$`);

/** @internal テストから差し替えできるようにしてるのだ */
export const deps = { execFile };

const RES_OK = JSON.stringify({ ok: true });
const RES_NOT_FOUND = JSON.stringify({ error: "Not Found" });
const RES_BAD_REQUEST = JSON.stringify({ error: "Bad Request" });
const RES_PAYLOAD_TOO_LARGE = JSON.stringify({ error: "Payload Too Large" });
const MAX_BODY_BYTES = 1024;
export const STOP_NOTIFICATION_DEDUP_MS = 5000;

let playing = false;
let bundledAssetFiles = null;

function getAssetSubdir(event) {
  return event === "notification" ? "notification" : "stop";
}

function getNotificationEventForAgentEventType(type) {
  if (type === "agent_turn.completed") return "stop";
  if (type === "alert.requested") return "notification";
  return null;
}

export function setBundledAssetFiles(filesByEvent) {
  bundledAssetFiles = filesByEvent;
}

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

export function playSound(wavPath) {
  if (playing) return;

  playing = true;
  deps.execFile("afplay", [wavPath], (err) => {
    playing = false;
    if (err) {
      console.error("⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！:", err.message);
    }
  });
}

/**
 * イベント種別に応じたランダム音声を再生するのだ
 */
export function playSoundForEvent(event) {
  const dir = resolve(ASSETS_DIR, getAssetSubdir(event));
  const files = bundledAssetFiles?.[event] ?? listWavFiles(dir);
  if (files.length === 0) {
    console.warn(`⚠ ${dir} に .wav ファイルが見つからないのだ！`);
    return;
  }
  playSound(pickRandom(files));
}

export function createNotifier({ now = () => Date.now(), play = playSoundForEvent } = {}) {
  let lastStopAt;

  return function notify(event) {
    const nowMs = now();
    if (event === "stop" && lastStopAt !== undefined && nowMs - lastStopAt < STOP_NOTIFICATION_DEDUP_MS) {
      return;
    }
    if (event === "stop") {
      lastStopAt = nowMs;
    }
    play(event);
  };
}

function readRequestBody(req, res, onBody) {
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
    if (!aborted) onBody(rawBody);
  });
}

function respondOk(res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(RES_OK);
}

function respondBadRequest(res) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(RES_BAD_REQUEST);
}

function parseAgentEvent(rawBody) {
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object" || !AGENT_EVENT_TYPES.includes(event.type)) {
    return null;
  }
  return event;
}

export function startServer(port, { now = () => Date.now(), notify = createNotifier({ now }) } = {}) {
  const server = createServer((req, res) => {
    const match = req.method === "POST" && req.url?.match(EVENT_PATH_PATTERN);
    if (match) {
      const event = match[1];
      readRequestBody(req, res, () => {
        respondOk(res);
        notify(event);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/agent-events") {
      readRequestBody(req, res, (rawBody) => {
        const event = parseAgentEvent(rawBody);
        if (!event) {
          respondBadRequest(res);
          return;
        }

        respondOk(res);
        const notificationEvent = getNotificationEventForAgentEventType(event.type);
        if (notificationEvent) notify(notificationEvent);
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
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    console.log(`ずんだもん通知サーバーが起動したのだ！ http://localhost:${activePort}`);
    console.log(`POST /agent-events  → AIエージェントのイベントを受け取るのだ！`);

    const stopFiles = bundledAssetFiles?.stop ?? listWavFiles(resolve(ASSETS_DIR, "stop"));
    const notifFiles = bundledAssetFiles?.notification ?? listWavFiles(resolve(ASSETS_DIR, "notification"));
    console.log(`🔊 stop: ${stopFiles.length}本, notification: ${notifFiles.length}本 の音声があるのだ！`);

    if (stopFiles.length === 0 || notifFiles.length === 0) {
      console.warn("");
      console.warn("⚠ assets/stop/ または assets/notification/ に .wav ファイルが足りないのだ！");
    }
  });

  return server;
}
