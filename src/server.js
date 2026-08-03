import { createServer } from "node:http";

const NOTIFICATION_EVENTS = ["stop", "notification"];
const AGENT_EVENT_NOTIFICATIONS = {
  "agent_turn.completed": "stop",
  "alert.requested": "notification",
};
const EVENT_PATH_PATTERN = new RegExp(`^/notifications/(${NOTIFICATION_EVENTS.join("|")})$`);

const RES_OK = JSON.stringify({ ok: true });
const RES_NOT_FOUND = JSON.stringify({ error: "Not Found" });
const RES_BAD_REQUEST = JSON.stringify({ error: "Bad Request" });
const RES_PAYLOAD_TOO_LARGE = JSON.stringify({ error: "Payload Too Large" });
const MAX_BODY_BYTES = 1024;

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

function parseAgentEventNotification(rawBody) {
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object") return null;
  return AGENT_EVENT_NOTIFICATIONS[event.type] ?? null;
}

export function startServer(port, notify) {
  if (typeof notify !== "function") throw new TypeError("notify is required");

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      respondOk(res);
      return;
    }

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
        const notificationEvent = parseAgentEventNotification(rawBody);
        if (!notificationEvent) {
          respondBadRequest(res);
          return;
        }

        respondOk(res);
        notify(notificationEvent);
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
  });

  return server;
}
