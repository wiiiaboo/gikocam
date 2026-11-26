// gikocam relay
//
// The phone page can't talk to gikopoipoi.net directly: the site sends no CORS
// headers, and browsers can't attach the `private-user-id` header to a
// websocket. This server does those two things on the phone's behalf and
// forwards everything else as-is. Video/audio never pass through here: the
// phone's RTCPeerConnection goes straight to gikopoipoi's media server, we only
// relay the offer/answer text.
//
// Phone <-> relay protocol (JSON over one websocket at /ws):
//   -> {t:"login", name, characterId, areaId, roomId}
//   <- {t:"login-ok", sessionKey, userId, room}      room = gikopoipoi room state
//   -> {t:"resume", sessionKey}                        after a dropped connection
//   <- {t:"resumed", userId, room, missed:[events]}
//   -> {t:"emit", event, args:[...]}                   allow-listed socket.io emits
//   <- {t:"event", event, args:[...]}                  every socket.io event from gikopoipoi
//   -> {t:"rooms"}            <- {t:"rooms", rooms}
//   -> {t:"logout"}
//   <- {t:"socket", state}    "connected" | "disconnected" | "rejected"
//   <- {t:"error", message}

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { io } from "socket.io-client";

const PORT = Number(process.env.PORT || 8080);
const GIKO = (process.env.GIKO_BASE_URL || "https://gikopoipoi.net").replace(/\/$/, "");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://wiiiaboo.github.io,http://localhost:8123,http://127.0.0.1:8123")
  .split(",").map(s => s.trim()).filter(Boolean);
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS || 90_000);
const MAX_MISSED_EVENTS = 300;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 10);
// When set, the relay also serves the phone page from this folder (VPS setup).
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

async function serveStatic(pathname, res) {
  if (!STATIC_DIR) return false;
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR + path.sep)) return false;
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
    return true;
  } catch {
    if (!rel.endsWith("index.html") && !path.extname(rel)) return serveStatic(pathname + "/", res);
    return false;
  }
}

// Only what the phone page needs. Anything else is dropped.
const ALLOWED_EMITS = new Set([
  "user-msg", "user-move", "user-bubble-position", "user-change-room", "user-ping",
  "user-want-to-stream", "user-want-to-stop-stream", "user-rtc-message",
]);

const log = (event, details = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));

async function gikoJson(path, init = {}) {
  const res = await fetch(GIKO + path, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${path}`);
  return res.json();
}

/** One gikopoipoi user, possibly outliving several phone websockets. */
class Session {
  constructor() {
    this.key = crypto.randomBytes(24).toString("base64url");
    this.ws = null;
    this.socket = null;
    this.userId = null;
    this.privateUserId = null;
    this.areaId = null;
    this.room = null;
    this.missed = [];
    this.expiryTimer = null;
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.t === "event" && this.missed.length < MAX_MISSED_EVENTS) this.missed.push(msg);
  }

  async login({ name, characterId, areaId, roomId }) {
    this.areaId = String(areaId || "for");
    const login = await gikoJson("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userName: String(name ?? "").slice(0, 40),
        characterId: String(characterId || "giko"),
        areaId: this.areaId,
        roomId: String(roomId || "admin_st"),
      }),
    });
    if (!login.isLoginSuccessful) throw new Error(login.error || "Login was rejected");
    this.userId = login.userId;
    this.privateUserId = login.privateUserId;
    this.room = await gikoJson(
      `/api/areas/${encodeURIComponent(this.areaId)}/rooms/${encodeURIComponent(String(roomId || "admin_st"))}`,
      { headers: { authorization: `Bearer ${this.privateUserId}` } });
    this.connectSocket();
  }

  connectSocket() {
    const socket = io(GIKO, {
      extraHeaders: { "private-user-id": this.privateUserId },
      closeOnBeforeunload: false,
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    this.socket = socket;
    socket.on("connect", () => this.send({ t: "socket", state: "connected" }));
    socket.on("disconnect", (reason) => this.send({ t: "socket", state: "disconnected", reason }));
    socket.on("server-cant-log-you-in", () => {
      this.send({ t: "socket", state: "rejected" });
      socket.disconnect();
    });
    socket.on("server-update-current-room-state", (state) => { this.room = state; });
    socket.onAny((event, ...args) => this.send({ t: "event", event, args }));
  }

  async rooms() {
    return gikoJson(`/api/areas/${encodeURIComponent(this.areaId)}/rooms`,
      { headers: { authorization: `Bearer ${this.privateUserId}` } });
  }

  attach(ws) {
    if (this.ws && this.ws !== ws) this.ws.close(4000, "replaced by a newer connection");
    this.ws = ws;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  detach(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    // Keep the gikopoipoi user (and so the stream slot) alive while the phone
    // reconnects; mobile data drops are normal.
    this.expiryTimer = setTimeout(() => this.destroy("resume_timeout"), RESUME_GRACE_MS);
  }

  destroy(reason) {
    clearTimeout(this.expiryTimer);
    sessions.delete(this.key);
    if (this.socket) {
      if (this.socket.connected) this.socket.emit("user-want-to-stop-stream");
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    if (this.ws) this.ws.close(1000, reason);
    log("session_closed", { reason, sessions: sessions.size });
  }
}

const sessions = new Map();

function originAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    }
    if (url.pathname === "/characters") {
      const catalog = await gikoJson("/api/characters/regular");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
      return res.end(JSON.stringify(Object.keys(catalog)));
    }
    if (req.method === "GET" && await serveStatic(url.pathname, res)) return;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("gikocam relay: nothing here. The phone page connects to /ws.");
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(String(e.message || e));
  }
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

wss.on("connection", (ws, req) => {
  if (!originAllowed(req.headers.origin)) {
    log("origin_rejected", { origin: req.headers.origin });
    return ws.close(4003, "origin not allowed");
  }
  let session = null;
  const reply = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return reply({ t: "error", message: "bad json" }); }
    try {
      switch (msg.t) {
        case "login": {
          if (session) return reply({ t: "error", message: "already logged in" });
          if (sessions.size >= MAX_SESSIONS) return reply({ t: "error", message: "relay is full" });
          const s = new Session();
          await s.login(msg);
          sessions.set(s.key, s);
          session = s;
          s.attach(ws);
          log("session_opened", { area: s.areaId, room: s.room?.currentRoom?.id, sessions: sessions.size });
          return reply({ t: "login-ok", sessionKey: s.key, userId: s.userId, room: s.room });
        }
        case "resume": {
          const s = sessions.get(String(msg.sessionKey));
          if (!s) return reply({ t: "resume-failed" });
          session = s;
          s.attach(ws);
          const missed = s.missed; s.missed = [];
          reply({ t: "resumed", userId: s.userId, room: s.room, socketConnected: !!s.socket?.connected, missed });
          return;
        }
        case "emit": {
          if (!session) return reply({ t: "error", message: "not logged in" });
          if (!ALLOWED_EMITS.has(msg.event)) return reply({ t: "error", message: "event not allowed: " + msg.event });
          session.socket.emit(msg.event, ...(Array.isArray(msg.args) ? msg.args : []));
          return;
        }
        case "rooms": {
          if (!session) return reply({ t: "error", message: "not logged in" });
          return reply({ t: "rooms", rooms: await session.rooms() });
        }
        case "logout": {
          if (session) session.destroy("logout");
          session = null;
          return;
        }
        default:
          return reply({ t: "error", message: "unknown message type" });
      }
    } catch (e) {
      log("request_failed", { t: msg.t, message: String(e.message || e) });
      reply({ t: "error", message: String(e.message || e), during: msg.t });
    }
  });

  ws.on("close", () => { if (session) session.detach(ws); });
});

// Detect phones that vanished without closing (common on mobile data).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

server.listen(PORT, () => log("listening", { port: PORT, giko: GIKO, origins: ALLOWED_ORIGINS }));
