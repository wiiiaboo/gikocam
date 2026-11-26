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
  "http://localhost:8123,http://127.0.0.1:8123")   // production sets this in deploy/docker-compose.yml
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

// gikopoipoi only lists rooms for a logged-in user, so the login screen gets
// the list from a live session in that area, or the last one any session saw.
const roomCache = new Map(); // areaId -> {at, rooms}
async function roomsForArea(areaId) {
  const live = [...sessions.values()].find((s) => s.areaId === areaId && s.privateUserId);
  if (live) {
    const cached = roomCache.get(areaId);
    if (!cached || Date.now() - cached.at > 30_000) await live.rooms().catch(() => {});
  }
  const c = roomCache.get(areaId);
  return { at: c?.at || null, rooms: (c?.rooms || []).map((r) => ({
    id: r.id, userCount: r.userCount || 0, streams: Array.isArray(r.streams) ? r.streams.length : 0,
  })) };
}

async function gikoJson(path, init = {}) {
  const res = await fetch(GIKO + path, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    // gikopoipoi puts the reason in the body, e.g. {"error":"ip_restricted"}.
    const reason = await res.json().then((b) => b && b.error).catch(() => null);
    throw new Error(`${res.status}${reason ? " " + reason : ""} from ${path}`);
  }
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
    this.rooms().catch(() => {}); // refresh the login screen's room list
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
    const rooms = await gikoJson(`/api/areas/${encodeURIComponent(this.areaId)}/rooms`,
      { headers: { authorization: `Bearer ${this.privateUserId}` } });
    if (Array.isArray(rooms)) roomCache.set(this.areaId, { at: Date.now(), rooms });
    return rooms;
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

// ---------------------------------------------------------------- access gate
// The access token is a plain text file (ACCESS_TOKEN_FILE) that the owner
// edits by hand. It is re-read every few seconds, so a new token works without
// a restart, and changing it logs every phone out. Without ACCESS_TOKEN_FILE
// (local development) there is no gate. With the file missing or empty the
// gate stays shut.
const TOKEN_FILE = process.env.ACCESS_TOKEN_FILE || null;
const COOKIE = "gikocam_auth";
let tokenCache = { at: 0, value: "" };

async function accessToken() {
  if (Date.now() - tokenCache.at < 5_000) return tokenCache.value;
  let value = "";
  try { value = (await fs.readFile(TOKEN_FILE, "utf8")).trim(); } catch {}
  tokenCache = { at: Date.now(), value };
  return value;
}
// The cookie holds a hash of the token, not the token itself.
const cookieValue = (token) => crypto.createHash("sha256").update("gikocam:" + token).digest("hex");

function sameText(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function isAuthed(req) {
  if (!TOKEN_FILE) return true;
  const token = await accessToken();
  if (!token) return false;
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return !!m && sameText(m[1], cookieValue(token));
}

// Slow down password guessing: 10 wrong tries per address per 15 minutes.
const failures = new Map();
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (f && Date.now() > f.until) { failures.delete(ip); return false; }
  return !!f && f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: Date.now() + 15 * 60_000 };
  f.count += 1; failures.set(ip, f);
}

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function loginPage(message) {
  const note = message ? `<p class="err">${message}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000000"><title>gikocam</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;color:#f2f2f2;font:15px/1.35 -apple-system,system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:calc(28vh + env(safe-area-inset-top)) 20px 20px}
h1{margin:0 0 18px;font-weight:700}
input[hidden]{display:none}input{display:block;width:100%;padding:12px 13px;margin:0 0 12px;background:#16161a;border:1px solid #333;border-radius:10px;color:#fff;font-size:16px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#4fc3f7;color:#000;font:600 17px -apple-system,system-ui,sans-serif}
.err{color:#ff8a80;margin:0 0 12px}
</style></head><body><main>
<h1>gikocam</h1>${note}
<form method="post" action="/login">
<input type="text" name="username" value="gikocam" autocomplete="username" hidden>
<input type="password" name="token" placeholder="Access token" autocomplete="current-password" autofocus required>
<button>Unlock</button>
</form></main></body></html>`;
}

async function handleLogin(req, res, url) {
  const html = (status, message) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loginPage(message));
  };
  if (req.method === "GET") return html(200, url.searchParams.has("expired") ? "Please unlock again." : "");
  const ip = clientIp(req);
  if (tooManyFailures(ip)) return html(429, "Too many wrong tries. Wait 15 minutes.");
  const token = await accessToken();
  if (!token) return html(503, "No access token is set on the server yet.");
  const given = (new URLSearchParams(await readBody(req)).get("token") || "").trim();
  if (!sameText(cookieValue(given), cookieValue(token))) {
    noteFailure(ip);
    log("login_failed", { ip });
    await new Promise((r) => setTimeout(r, 800));
    return html(401, "Wrong access token.");
  }
  failures.delete(ip);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.writeHead(303, {
    location: "/",
    "set-cookie": `${COOKIE}=${cookieValue(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
    "cache-control": "no-store",
  });
  res.end();
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
    if (TOKEN_FILE) {
      if (url.pathname === "/login") return await handleLogin(req, res, url);
      if (url.pathname === "/logout") {
        res.writeHead(303, { location: "/login", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
        return res.end();
      }
      if (!(await isAuthed(req))) {
        const isPage = req.method === "GET" && (url.pathname.endsWith("/") || url.pathname.endsWith(".html"));
        if (isPage) { res.writeHead(303, { location: "/login", "cache-control": "no-store" }); return res.end(); }
        res.writeHead(401, { "content-type": "text/plain" });
        return res.end("locked");
      }
    }
    if (url.pathname === "/characters") {
      const catalog = await gikoJson("/api/characters/regular");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
      return res.end(JSON.stringify(Object.keys(catalog)));
    }
    if (url.pathname === "/rooms") {
      const area = String(url.searchParams.get("area") || "for").slice(0, 20);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(await roomsForArea(area)));
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
  // The page can't load without the cookie, but check it here too so the
  // relay itself isn't usable without the access token.
  const authed = isAuthed(req);
  authed.then((ok) => { if (!ok) ws.close(4001, "locked"); });
  let session = null;
  const reply = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (raw) => {
    if (!(await authed)) return;
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
