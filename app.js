"use strict";
// gikocam phone client.
// Signalling + chat go through the relay (see server/server.js). Video goes
// straight from this page's RTCPeerConnection to gikopoipoi's media server.

const GIKO = "https://gikopoipoi.net";
// The page is served by the relay itself (cam.gikochan.net), so the relay is
// always at /ws on the same address.
const DEFAULT_RELAY = new URL("ws", location.href).href.replace(/^http/, "ws");
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };
const FALLBACK_CHARS = ["giko", "shii", "naito", "hikki", "shobon", "tinpopo", "nida", "salmon", "giko_hat", "shii_hat"];
const ZOOM_PRESETS = [0.5, 1, 2, 3, 5];
const CHAT_FADE_MS = 15000;

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem("gikocam." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("gikocam." + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ state
const S = {
  relayUrl: new URLSearchParams(location.search).get("relay") || store.get("relay", DEFAULT_RELAY),
  ws: null, sessionKey: null, userId: null, loggedIn: false, relayRetry: 0,
  room: null, users: new Map(), streams: [],
  // camera
  videoTrack: null, audioTrack: null, devices: [], backId: null, frontId: null, facing: "back", fixedLensId: null,
  micMuted: false, wakeLock: null,
  // stream
  wantLive: false, slot: null, pc: null, pendingOffer: null, streamState: "off", peerRetry: 0,
  brb: null, // {since, reason: "pause" | "camera"} while viewers see the be-right-back screen
};
if (new URLSearchParams(location.search).get("relay")) store.set("relay", S.relayUrl);

// ------------------------------------------------------------------ UI helpers
function toast(text, ms = 3000) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
function setStatus() {
  const el = $("status");
  let text = "offline", cls = "";
  const relayUp = S.ws && S.ws.readyState === 1;
  if (!relayUp) { text = S.loggedIn ? "reconnecting…" : "offline"; cls = "warn"; }
  else if (S.brb && S.wantLive) { text = "BRB"; cls = "brb"; }
  else if (S.streamState === "live") { text = "LIVE"; cls = "is-live"; }
  else if (S.streamState === "requesting" || S.streamState === "connecting") { text = "connecting…"; cls = "warn"; }
  else if (S.streamState === "reconnecting") { text = "stream reconnecting…"; cls = "warn"; }
  else text = "not streaming";
  el.textContent = text; el.className = "pill status " + cls;
  const live = $("live");
  live.textContent = S.wantLive ? "End stream" : "Go live";
  live.classList.toggle("on", S.wantLive);
  const bb = $("brbBtn");
  bb.hidden = !S.wantLive; $("brbSpacer").hidden = S.wantLive;
  bb.classList.toggle("on", !!S.brb);
  bb.textContent = S.brb ? "▶" : "☕";
  bb.setAttribute("aria-label", S.brb ? "Back on camera" : "Be right back");
}

// ------------------------------------------------------------------ login screen
async function initLogin() {
  $("name").value = store.get("name", "");
  $("area").value = store.get("area", "for");
  $("relayUrl").value = S.relayUrl;
  loadLoginRooms();
  let chars = FALLBACK_CHARS;
  try {
    const r = await fetch(S.relayUrl.replace(/^ws/, "http").replace(/\/ws$/, "/characters"));
    if (r.ok) chars = await r.json();
  } catch {}
  const selected = store.get("character", "giko");
  const box = $("chars"); box.innerHTML = "";
  for (const id of chars) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.id = id; b.title = id;
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = id;
    img.src = `${GIKO}/characters/${encodeURIComponent(id)}/front-standing.svg`;
    img.onerror = () => b.remove();
    b.appendChild(img);
    if (id === selected) b.classList.add("sel");
    b.onclick = () => { box.querySelectorAll(".sel").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); };
    box.appendChild(b);
  }
  if (!box.querySelector(".sel") && box.firstChild) box.firstChild.classList.add("sel");
}

// Room picker: the last room used in this area is preselected.
$("area").onchange = () => loadLoginRooms();
async function loadLoginRooms() {
  const areaId = $("area").value, sel = $("room");
  const last = store.get("room:" + areaId, "admin_st");
  const fill = (rooms) => {
    sel.innerHTML = "";
    const add = (id, label) => { const o = document.createElement("option"); o.value = id; o.textContent = label; sel.appendChild(o); };
    const byId = new Map(rooms.map(r => [r.id, r]));
    const label = (r) => r.id + (r.userCount ? ` · ${r.userCount}👤` : "") + (r.streams ? ` · ${r.streams} streaming` : "");
    add(last, byId.has(last) ? label(byId.get(last)) + " (last)" : last + " (last)");
    for (const r of [...rooms].sort((a, b) => b.userCount - a.userCount || a.id.localeCompare(b.id)))
      if (r.id !== last) add(r.id, label(r));
    if (!byId.has("admin_st") && last !== "admin_st") add("admin_st", "admin_st");
    sel.value = last;
  };
  fill([]);
  try {
    const r = await fetch(S.relayUrl.replace(/^ws/, "http").replace(/\/ws$/, "/rooms") + "?area=" + encodeURIComponent(areaId));
    if (r.ok && $("area").value === areaId) fill((await r.json()).rooms || []);
  } catch {}
}

$("enter").onclick = async () => {
  const err = $("loginError"); err.hidden = true;
  const name = $("name").value.trim();
  const sel = $("chars").querySelector(".sel");
  const characterId = sel ? sel.dataset.id : "giko";
  const areaId = $("area").value;
  const relay = $("relayUrl").value.trim() || DEFAULT_RELAY;
  store.set("name", name); store.set("character", characterId); store.set("area", areaId); store.set("relay", relay);
  S.relayUrl = relay;
  $("enter").disabled = true; $("enter").textContent = "Starting camera…";
  try {
    await startCamera();            // inside the tap, so iOS allows camera + mic
    $("enter").textContent = "Connecting…";
    if (!S.ws || S.ws.readyState !== 1) await connectRelay();
    // A previous session from this phone still in gikopoipoi: end it, or there'd be two of you.
    if (oldSession) { await request({ t: "end", sessionKey: oldSession.key }, ["ended"]).catch(() => {}); hideRejoin(); }
    const res = await request({ t: "login", name, characterId, areaId, roomId: $("room").value || "admin_st" }, ["login-ok"])
      .catch(e => { throw new Error(/ip_restricted/.test(e.message)
        ? "gikopoipoi refused the login: this network's IP is restricted (ip_restricted)."
        : /\/api\/login/.test(e.message)
        ? "gikopoipoi refused the login (" + e.message.replace(/ from .*/, "") + "). Wait a minute and try again." : e.message); });
    onLoggedIn(res);
    $("login").hidden = true; $("cam").hidden = false;
    acquireWakeLock();
  } catch (e) {
    err.textContent = e.message || String(e); err.hidden = false;
    stopCamera();
  }
  $("enter").disabled = false; $("enter").textContent = "Enter";
};

// ------------------------------------------------------------------ rejoin
// Closing the browser doesn't end the gikopoipoi session (the relay can't tell
// it from losing signal, and keeps the stream on the BRB screen). When the page
// opens again, offer to pick that session back up, or end it.
let oldSession = null; // {key, name, roomId, live, brb, slot}
async function checkOldSession() {
  const key = store.get("session", null);
  if (!key) return;
  try {
    if (!S.ws || S.ws.readyState !== 1) await connectRelay();
    const p = await request({ t: "peek", sessionKey: key }, ["peek"]);
    if (!p.alive) { store.set("session", null); return; }
    oldSession = { ...p, key };
    $("rejoinText").textContent = `You're still in gikopoipoi as ${p.name || "Anonymous"} in ${p.roomId || "?"}` +
      (p.brb ? ", viewers are seeing your be-right-back screen." : p.live ? ", still streaming." : ".");
    $("rejoin").hidden = false;
    $("enter").textContent = "Enter as someone new";
  } catch {}
}
function hideRejoin() {
  oldSession = null; store.set("session", null);
  $("rejoin").hidden = true; $("enter").textContent = "Enter";
}
$("endBtn").onclick = async () => {
  if (!oldSession) return;
  $("endBtn").disabled = true;
  await request({ t: "end", sessionKey: oldSession.key }, ["ended"]).catch(() => {});
  $("endBtn").disabled = false;
  hideRejoin();
};
$("rejoinBtn").onclick = async () => {
  if (!oldSession) return;
  const err = $("loginError"); err.hidden = true;
  const old = oldSession;
  $("rejoinBtn").disabled = true; $("rejoinBtn").textContent = "Starting camera…";
  try {
    await startCamera();            // inside the tap, so iOS allows camera + mic
    if (!S.ws || S.ws.readyState !== 1) await connectRelay();
    const res = await request({ t: "resume", sessionKey: old.key }, ["resumed", "resume-failed"]);
    if (res.t === "resume-failed") throw new Error("That session has just ended. Enter again.");
    S.sessionKey = old.key; S.userId = res.userId; S.loggedIn = true;
    S.wantLive = !!old.live;
    applyRoomState(res.room);
    for (const m of res.missed) onRelayMessage(m);
    oldSession = null; $("rejoin").hidden = true;
    $("login").hidden = true; $("cam").hidden = false;
    sysMsg(`Rejoined ${roomLabel()}`);
    acquireWakeLock();
    if (S.wantLive && !res.brb && Number.isInteger(old.slot)) {
      // The old page's stream may still hold the slot: stop it, then take the slot again.
      emit("user-want-to-stop-stream");
      S.streamState = "off";
      setTimeout(() => requestStream(old.slot), 1500);
    }
    // With the BRB stream up, the relay sends brb-handback once the slot is free.
    setStatus();
  } catch (e) {
    err.textContent = e.message || String(e); err.hidden = false;
    stopCamera();
  }
  $("rejoinBtn").disabled = false; $("rejoinBtn").textContent = "Rejoin";
};

// ------------------------------------------------------------------ relay connection
let pending = null; // {types, resolve, reject}
function connectRelay() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(S.relayUrl);
    S.ws = ws;
    const timer = setTimeout(() => { ws.close(); reject(new Error("Relay server did not answer (it may be waking up — try again in a minute)")); }, 60000);
    ws.onopen = () => { clearTimeout(timer); S.relayRetry = 0; setStatus(); resolve(); };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (S.ws !== ws) return;
      // 4001: the access token was changed (or the cookie expired). Unlock again.
      if (ev.code === 4001) { S.loggedIn = false; location.href = "login?expired"; return; }
      setStatus();
      if (pending) { pending.reject(new Error("Lost connection to relay")); pending = null; }
      if (S.loggedIn) scheduleRelayReconnect(); else reject(new Error("Could not reach relay server"));
    };
    ws.onmessage = (ev) => onRelayMessage(JSON.parse(ev.data));
  });
}
function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }
function emit(event, ...args) { send({ t: "emit", event, args }); }
function request(msg, types) {
  return new Promise((resolve, reject) => { pending = { types, resolve, reject }; send(msg); });
}

function scheduleRelayReconnect() {
  const wait = Math.min(10000, 500 * 2 ** S.relayRetry++);
  setTimeout(async () => {
    if (!S.loggedIn) return;
    try {
      await connectRelay();
      const res = await request({ t: "resume", sessionKey: S.sessionKey }, ["resumed", "resume-failed"]);
      if (res.t === "resume-failed") { sysMsg("Session expired, logging in again"); return relogin(); }
      applyRoomState(res.room);
      for (const m of res.missed) onRelayMessage(m);
      // With the relay's BRB stream up, a brb-handback (with our slot) follows.
      if (res.socketConnected && S.wantLive && !S.pc && !res.brb) requestStream();
    } catch { /* onclose schedules the next attempt */ }
  }, wait);
}

async function relogin() {
  const name = store.get("name", ""), characterId = store.get("character", "giko"), areaId = store.get("area", "for");
  const res = await request({ t: "login", name, characterId, areaId, roomId: S.room?.currentRoom?.id || "admin_st" }, ["login-ok"]);
  onLoggedIn(res);
}

function onLoggedIn(res) {
  S.sessionKey = res.sessionKey; S.userId = res.userId; S.loggedIn = true;
  store.set("session", res.sessionKey);
  applyRoomState(res.room);
  sysMsg(`Joined ${roomLabel()} as ${store.get("name", "") || "Anonymous"}`);
  if (S.wantLive) { closePeer(); requestStream(); }
  setStatus();
}

function onRelayMessage(m) {
  if (pending && (pending.types.includes(m.t) || m.t === "error")) {
    const p = pending; pending = null;
    if (m.t === "error") p.reject(new Error(m.message)); else p.resolve(m);
    return;
  }
  switch (m.t) {
    case "event": return onGikoEvent(m.event, m.args || []);
    case "rooms": return renderRooms(m.rooms);
    case "brb-handback": return onBrbHandback(m.slot);
    case "socket":
      if (m.state === "connected") { if (S.wantLive && !S.pc) requestStream(); }
      else if (m.state === "disconnected") { sysMsg("gikopoipoi connection dropped, reconnecting…"); closePeer(); S.streamState = S.wantLive ? "reconnecting" : "off"; }
      else if (m.state === "rejected") { sysMsg("gikopoipoi rejected the session"); S.wantLive = false; closePeer(); }
      return setStatus();
    case "error": return toast(m.message);
  }
}

// ------------------------------------------------------------------ gikopoipoi events
function applyRoomState(state) {
  if (!state) return;
  S.room = state;
  S.users = new Map((state.connectedUsers || []).map(u => [u.id, u]));
  S.streams = state.streams || [];
  if (state.currentRoom) store.set("room:" + store.get("area", "for"), state.currentRoom.id);
  const me = S.users.get(S.userId);
  if (me && me.position) { M.x = me.position.x; M.y = me.position.y; showPos(); }
  M.waiting = false;
  RV.onRoom();
  $("roomName").textContent = roomLabel();
  $("userCount").textContent = S.users.size;
}
const roomLabel = () => (S.room && S.room.currentRoom && S.room.currentRoom.id) || "?";
const userName = (id) => { const u = S.users.get(id); return u ? (u.name || "Anonymous") : "?"; };

function onGikoEvent(event, args) {
  switch (event) {
    case "server-update-current-room-state":
      { const before = roomLabel(); applyRoomState(args[0]); if (roomLabel() !== before) sysMsg(`Now in ${roomLabel()}`); }
      checkOwnSlot();
      break;
    case "server-user-joined-room":
      S.users.set(args[0].id, args[0]); $("userCount").textContent = S.users.size; RV.requestDraw();
      sysMsg(`${args[0].name || "Anonymous"} joined`);
      break;
    case "server-user-left-room":
      if (args[0] !== S.userId) sysMsg(`${userName(args[0])} left`);
      S.users.delete(args[0]); $("userCount").textContent = S.users.size; RV.requestDraw();
      break;
    case "server-character-changed": {
      const u = S.users.get(args[0]);
      if (u) { u.characterId = args[1]; RV.requestDraw(); }
      break;
    }
    case "server-user-inactive": case "server-user-active": {
      const u = S.users.get(args[0]);
      if (u) { u.isInactive = event === "server-user-inactive"; RV.requestDraw(); }
      break;
    }
    case "server-move":
      onServerMove(args[0]);
      break;
    case "server-reject-movement":
      M.waiting = false;
      break;
    case "server-msg":
      if (args[1]) chatMsg(userName(args[0]), args[1], args[0] === S.userId);
      break;
    case "server-system-message":
      sysMsg(String(args[0]).replace(/_/g, " ") + (args[1] ? " " + args[1] : ""));
      break;
    case "server-update-current-room-streams":
      S.streams = args[0] || []; checkOwnSlot();
      break;
    case "server-ok-to-stream":
      S.startRetry = 0;
      startPeer();
      break;
    case "server-not-ok-to-stream":
      // Right after a stop (BRB handback) gikopoipoi can refuse a start; try again.
      if (S.wantLive && /unknown_error/.test(String(args[0])) && (S.startRetry = (S.startRetry || 0) + 1) <= 4) {
        const slot = S.slot; S.slot = null; S.streamState = "off";
        setTimeout(() => requestStream(slot), 1500);
        break;
      }
      sysMsg("Stream refused: " + String(args[0] || "no reason given").replace(/_/g, " "));
      S.wantLive = false; S.slot = null; S.streamState = "off"; setStatus();
      break;
    case "server-rtc-message":
      onRtcMessage(args[0], args[1], args[2]);
      break;
  }
}

function checkOwnSlot() {
  if (S.slot === null || !S.pc) return;
  const s = S.streams[S.slot];
  if (s && s.isActive && s.userId === S.userId) return;
  if (S.streamState === "requesting") return;
  // Our slot went away (room change, kicked, server restart).
  closePeer(); S.slot = null;
  if (S.wantLive) { S.streamState = "reconnecting"; setTimeout(requestStream, 1500); }
  else S.streamState = "off";
  setStatus();
}

// ------------------------------------------------------------------ chat
function addLine(container, el) {
  container.appendChild(el);
  while (container.children.length > 200) container.firstChild.remove();
}
function makeMsg(name, text, cls) {
  const d = document.createElement("div"); d.className = "msg " + (cls || "");
  if (name) { const b = document.createElement("b"); b.textContent = name; d.appendChild(b); }
  d.appendChild(document.createTextNode(text));
  return d;
}
function chatMsg(name, text, mine) { postMsg(makeMsg(name, text, mine ? "mine" : "")); }
function sysMsg(text) { postMsg(makeMsg("", text, "sys")); }
function postMsg(el) {
  addLine($("chatLog"), el.cloneNode(true));
  $("chatLog").scrollTop = 1e9;
  const feed = $("chatFeed");
  addLine(feed, el);
  while (feed.children.length > 8) feed.firstChild.remove();
  setTimeout(() => el.classList.add("fade"), CHAT_FADE_MS);
  setTimeout(() => el.remove(), CHAT_FADE_MS + 1000);
}
$("chatBtn").onclick = () => { $("chatPanel").hidden = false; $("chatFeed").hidden = true; $("chatLog").scrollTop = 1e9; $("chatInput").focus(); };
$("chatClose").onclick = () => { $("chatPanel").hidden = true; $("chatFeed").hidden = false; $("chatInput").blur(); };
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  emit("user-msg", text);
  // A second, empty message clears the speech bubble over the avatar (same as
  // pressing Enter twice in gikopoipoi). The message stays in everyone's log.
  emit("user-msg", "");
  $("chatInput").value = "";
};

// ------------------------------------------------------------------ avatar movement
// Like gikopoipoi's own client: while a direction is held, send one step at a
// time, waiting for the server to confirm (server-move) or refuse
// (server-reject-movement) before the next, plus a short pause while the
// avatar's walk animation plays. Facing a new direction is a step that only turns.
const M = { dir: null, waiting: false, sentAt: 0, readyAt: 0, x: null, y: null };
const WALK_MS = 350, TURN_MS = 120;

function onServerMove(dto) {
  if (!dto) return;
  const u = S.users.get(dto.userId);
  if (u) {
    RV.startWalk(u, dto);
    u.position = { x: dto.x, y: dto.y }; u.direction = dto.direction; u.isInactive = false;
  }
  RV.requestDraw();
  if (dto.userId !== S.userId) return;
  const moved = dto.x !== M.x || dto.y !== M.y;
  M.x = dto.x; M.y = dto.y; M.waiting = false;
  M.readyAt = Date.now() + (moved && !dto.isInstant ? WALK_MS : TURN_MS);
  showPos();
  if (moved && !dto.isInstant) enterDoorIfOnOne();
}

// Stepping onto a door square takes you to the room behind it, as in gikopoipoi.
let doorRequested = false;
function enterDoorIfOnOne() {
  const room = S.room && S.room.currentRoom;
  if (!room || !room.doors || doorRequested) return;
  const door = Object.values(room.doors).find(d => d.target && d.x === M.x && d.y === M.y);
  if (!door) return;
  doorRequested = true; M.dir = null;
  if (S.wantLive) toast("Your stream will restart in the new room");
  emit("user-change-room", { targetRoomId: door.target.roomId, targetDoorId: door.target.doorId });
}
function showPos() { $("padPos").textContent = M.x === null ? "–" : `${M.x},${M.y}`; }

setInterval(() => {
  if (!M.dir || !S.loggedIn) return;
  const now = Date.now();
  if (M.waiting && now - M.sentAt > 2000) M.waiting = false;   // lost reply; don't get stuck
  if (M.waiting || now < M.readyAt) return;
  M.waiting = true; M.sentAt = now;
  emit("user-move", M.dir);
}, 100);

for (const b of $("pad").querySelectorAll("button")) {
  const start = (e) => {
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch {}
    M.dir = b.dataset.dir; b.classList.add("held");
  };
  const end = () => { if (M.dir === b.dataset.dir) M.dir = null; b.classList.remove("held"); };
  b.addEventListener("pointerdown", start);
  b.addEventListener("pointerup", end);
  b.addEventListener("pointercancel", end);
  b.addEventListener("lostpointercapture", end);
  b.addEventListener("contextmenu", (e) => e.preventDefault());
}
$("padBtn").onclick = () => {
  const show = $("pad").hidden;
  $("pad").hidden = !show; $("padBtn").classList.toggle("on", show);
  $("roomView").hidden = !show; $("cam").classList.toggle("moving", show);
  if (show) RV.show();
  if (!show) M.dir = null;
};

// ------------------------------------------------------------------ room view
// A small live picture of the room, drawn the way gikopoipoi's client does it:
// background image, then room objects and avatars back-to-front, positioned
// with the room's isometric grid. The view follows your own avatar.
const RV = (() => {
  const canvas = $("roomCanvas"), ctx = canvas.getContext("2d");
  const images = new Map();   // url -> HTMLImageElement (loaded or loading)
  const walks = new Map();    // userId -> {fx, fy, t0} smoothing for steps
  let drawQueued = false, animating = false, roomId = null;
  const STEP_MS = 330, CHAR_SCALE = 0.5;

  function img(url, fallback) {
    let im = images.get(url);
    if (!im) {
      im = new Image();
      im.onload = requestDraw;
      if (fallback) im.onerror = () => { if (im.src !== fallback) im.src = fallback; };
      im.src = url;
      images.set(url, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }
  const room = () => S.room && S.room.currentRoom;
  const visible = () => !$("roomView").hidden && !$("cam").hidden;

  function real(r, x, y) {   // calculateRealCoordinates from gikopoipoi
    const bw = r.blockWidth || 80, bh = r.blockHeight || 40;
    return { x: r.originCoordinates.x + x * bw / 2 + y * bw / 2, y: r.originCoordinates.y + x * bh / 2 - y * bh / 2 };
  }
  function userPhys(r, u, now) {
    const to = real(r, u.position.x, u.position.y);
    const w = walks.get(u.id);
    if (!w) return to;
    const t = Math.min(1, (now - w.t0) / STEP_MS);
    if (t >= 1) { walks.delete(u.id); return to; }
    return { x: w.fx + (to.x - w.fx) * t, y: w.fy + (to.y - w.fy) * t };
  }
  function startWalk(u, dto) {
    const r = room();
    if (!r || !u.position || dto.isInstant || (u.position.x === dto.x && u.position.y === dto.y)) return;
    const from = userPhys(r, u, performance.now());
    walks.set(u.id, { fx: from.x, fy: from.y, t0: performance.now() });
  }

  function requestDraw() {
    if (drawQueued || !visible()) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    const r = room();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = (r && r.backgroundColor) || "#1b1b1f";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!r) return;
    const roomScale = r.scale || 1, bw = r.blockWidth || 80;
    const bg = img(`${GIKO}/${r.backgroundImageUrl}`);
    const worldW = bg ? bg.naturalWidth * roomScale : 1200, worldH = bg ? bg.naturalHeight * roomScale : 800;
    const now = performance.now();

    // Zoom so a decent chunk of the room is visible, then centre on our avatar.
    const scale = Math.max(cw / worldW, 0.6) * dpr;
    const me = S.users.get(S.userId);
    const mp = me && me.position ? userPhys(r, me, now) : { x: worldW / 2, y: worldH / 2 };
    let camX = mp.x + bw / 2 - canvas.width / scale / 2, camY = mp.y - 60 - canvas.height / scale / 2;
    camX = Math.max(Math.min(camX, worldW - canvas.width / scale), Math.min(0, worldW - canvas.width / scale));
    camY = Math.max(Math.min(camY, worldH - canvas.height / scale), Math.min(0, worldH - canvas.height / scale));
    if (worldW * scale < canvas.width) camX = -(canvas.width / scale - worldW) / 2;
    if (worldH * scale < canvas.height) camY = -(canvas.height / scale - worldH) / 2;
    ctx.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);

    if (bg) ctx.drawImage(bg, 0, 0, worldW, worldH);

    // Back-to-front, using gikopoipoi's priority order (objects before avatars on ties).
    const sy = r.size ? r.size.y : 0;
    const items = [];
    for (const o of r.objects || []) {
      if (o.isHidden) continue;
      items.push({ p: o.x + 1 + (sy - o.y), k: 0, o });
    }
    for (const u of S.users.values()) if (u.position) items.push({ p: u.position.x + 1 + (sy - u.position.y), k: 1, u });
    items.sort((a, b) => a.p - b.p || a.k - b.k);

    let moving = false;
    const labels = [];
    for (const it of items) {
      if (it.o) {
        const o = it.o, s = o.scale || 1;
        const url = typeof o.url === "string" ? o.url : (o.url && o.url[0]);
        if (!url) continue;
        const im = img(`${GIKO}/rooms/${r.id}/${url}`);
        if (im) ctx.drawImage(im, (o.offset ? o.offset.x : 0) * s, (o.offset ? o.offset.y : 0) * s, im.naturalWidth * s, im.naturalHeight * s);
        continue;
      }
      const u = it.u;
      if (walks.has(u.id)) moving = true;
      const p = userPhys(r, u, now);
      const back = u.direction === "up" || u.direction === "left";
      const mirror = u.direction === "left" || u.direction === "down";
      const base = `${GIKO}/characters/${encodeURIComponent(u.characterId)}/${back ? "back" : "front"}-standing`;
      const im = img(base + ".svg", base + ".png");
      const cx = p.x + bw / 2;
      if (im) {
        const w = im.naturalWidth * CHAR_SCALE, h = im.naturalHeight * CHAR_SCALE;
        ctx.save();
        if (u.isInactive) ctx.globalAlpha = 0.5;
        if (mirror) { ctx.translate(cx, 0); ctx.scale(-1, 1); ctx.drawImage(im, -w / 2, p.y - h, w, h); }
        else ctx.drawImage(im, cx - w / 2, p.y - h, w, h);
        ctx.restore();
      }
      labels.push({ x: cx, y: p.y - (im ? im.naturalHeight * CHAR_SCALE : 90) - 6, name: u.name || "Anonymous", mine: u.id === S.userId });
    }

    // Names on top of everything; ours highlighted with a marker.
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const l of labels) {
      ctx.font = `${l.mine ? "bold " : ""}15px -apple-system, system-ui, sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.strokeText(l.name, l.x, l.y);
      ctx.fillStyle = l.mine ? "#4fc3f7" : "#fff"; ctx.fillText(l.name, l.x, l.y);
      if (l.mine) {
        ctx.fillStyle = "#4fc3f7";
        ctx.beginPath(); ctx.moveTo(l.x - 9, l.y - 22); ctx.lineTo(l.x + 9, l.y - 22); ctx.lineTo(l.x, l.y - 10); ctx.closePath(); ctx.fill();
      }
    }
    if (moving) requestDraw();
  }

  function onRoom() {
    const r = room();
    if (r && r.id !== roomId) { roomId = r.id; walks.clear(); doorRequested = false; }
    requestDraw();
  }
  function show() { requestAnimationFrame(draw); }
  window.addEventListener("resize", requestDraw);
  return { requestDraw, startWalk, onRoom, show };
})();

// Keep the avatar from being marked inactive during a long stream.
setInterval(() => { if (S.loggedIn) emit("user-ping"); }, 5 * 60 * 1000);

// ------------------------------------------------------------------ rooms
$("roomBtn").onclick = () => { $("roomsPanel").hidden = false; $("roomsList").textContent = "Loading…"; send({ t: "rooms" }); };
function renderRooms(rooms) {
  const box = $("roomsList"); box.innerHTML = "";
  rooms.sort((a, b) => b.userCount - a.userCount);
  for (const r of rooms) {
    const b = document.createElement("button");
    if (r.id === roomLabel()) b.classList.add("here");
    const name = document.createElement("span"); name.textContent = r.id;
    const info = document.createElement("small");
    info.textContent = `${r.userCount}👤` + (r.streams && r.streams.length ? ` · ${r.streams.length} streaming` : "");
    b.append(name, info);
    b.onclick = () => {
      $("roomsPanel").hidden = true;
      if (r.id === roomLabel()) return;
      if (S.wantLive) toast("Your stream will restart in the new room");
      emit("user-change-room", { targetRoomId: r.id });
    };
    box.appendChild(b);
  }
}
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { b.closest(".sheet").hidden = true; });

// ------------------------------------------------------------------ camera
const videoConstraints = (deviceId) => ({
  deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
});

async function startCamera() {
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  S.videoTrack = s.getVideoTracks()[0];
  S.audioTrack = s.getAudioTracks()[0];
  await refreshDevices();
  const cur = S.videoTrack.getSettings().deviceId;
  if (S.backId && cur !== S.backId) await setVideoDevice(S.backId);
  else showPreview();
  renderMics();
}

function stopCamera() {
  for (const t of [S.videoTrack, S.audioTrack]) if (t) t.stop();
  S.videoTrack = S.audioTrack = null;
}

async function refreshDevices() {
  S.devices = await navigator.mediaDevices.enumerateDevices();
  const cams = S.devices.filter(d => d.kind === "videoinput");
  const find = (re) => cams.find(d => re.test(d.label));
  // The "Triple"/"Dual Wide" virtual cameras switch lenses by themselves while
  // zooming (0.5x–10x), like the iPhone Camera app.
  S.backId = (find(/back triple/i) || find(/back dual wide/i) || find(/back dual/i) || find(/^back camera$/i) ||
              find(/back|rear|environment/i) || cams[0] || {}).deviceId || null;
  S.frontId = (find(/^front camera$/i) || find(/front|user|face/i) || {}).deviceId || null;
  $("flip").hidden = !S.frontId;
  renderLenses();
}

async function setVideoDevice(deviceId) {
  const old = S.videoTrack;
  let nt;
  try {
    nt = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(deviceId) })).getVideoTracks()[0];
  } catch (e) {
    // iOS sometimes refuses a second camera while one is open; free it and retry.
    if (old) old.stop();
    nt = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(deviceId) })).getVideoTracks()[0];
  }
  const sender = videoSender();
  if (sender && !S.brb) await sender.replaceTrack(nt);
  if (old && old !== nt) old.stop();
  S.videoTrack = nt;
  showPreview();
}

function showPreview() {
  const v = $("preview");
  v.srcObject = new MediaStream([S.videoTrack]);
  v.classList.toggle("mirror", S.videoTrack.getSettings().facingMode === "user");
  renderZooms(); renderTorch(); renderLenses();
  // Camera taken away (call, another app, backgrounded): viewers get the BRB screen.
  const t = S.videoTrack;
  const lost = () => { if (t === S.videoTrack && S.wantLive) BRB.enter("camera"); };
  t.onmute = lost; t.onended = lost;
  t.onunmute = () => { if (t === S.videoTrack && S.brb && S.brb.reason === "camera") BRB.exit(); };
  if (S.brb && S.brb.reason === "camera" && t.readyState === "live" && !t.muted) BRB.exit();
}

$("flip").onclick = async () => {
  const toFront = S.facing === "back";
  const id = toFront ? S.frontId : (S.fixedLensId || S.backId);
  if (!id) return;
  try { await setVideoDevice(id); S.facing = toFront ? "front" : "back"; }
  catch (e) { toast("Camera switch failed: " + e.message); }
};

// ---- zoom
const zoomCaps = () => {
  const c = S.videoTrack && S.videoTrack.getCapabilities ? S.videoTrack.getCapabilities() : {};
  // Single lenses advertise zoom but ignore it on iOS; only offer it on cameras whose min < 1 (virtual multi-lens).
  return c.zoom && c.zoom.min < 1 ? c.zoom : null;
};
let zoomBusy = false, zoomNext = null;
async function setZoom(z) {
  const caps = zoomCaps(); if (!caps) return;
  z = Math.min(caps.max, Math.max(caps.min, z));
  if (zoomBusy) { zoomNext = z; return; }
  zoomBusy = true;
  try { await S.videoTrack.applyConstraints({ advanced: [{ zoom: z }] }); } catch {}
  zoomBusy = false;
  markZoom();
  if (zoomNext !== null) { const n = zoomNext; zoomNext = null; setZoom(n); }
}
function currentZoom() { return (S.videoTrack && S.videoTrack.getSettings().zoom) || 1; }
function renderZooms() {
  const box = $("zooms"); box.innerHTML = "";
  const caps = zoomCaps(); if (!caps) return;
  for (const z of ZOOM_PRESETS.filter(z => z >= caps.min && z <= caps.max)) {
    const b = document.createElement("button"); b.dataset.z = z;
    b.onclick = () => setZoom(z);
    box.appendChild(b);
  }
  markZoom();
}
function markZoom() {
  const z = currentZoom();
  let best = null;
  for (const b of $("zooms").children) {
    const p = +b.dataset.z;
    if (p <= z + 0.01) best = b;
    b.textContent = p + "×"; b.classList.remove("sel");
  }
  if (best) { best.classList.add("sel"); if (Math.abs(+best.dataset.z - z) > 0.05) best.textContent = z.toFixed(1) + "×"; }
}

let pinch = null;
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$("cam").addEventListener("touchstart", (e) => {
  if (e.touches.length === 2 && zoomCaps() && $("chatPanel").hidden && !e.target.closest("#roomView")) {
    pinch = { d0: dist(e.touches), z0: currentZoom() }; e.preventDefault();
  }
}, { passive: false });
$("cam").addEventListener("touchmove", (e) => {
  if (pinch && e.touches.length === 2) { e.preventDefault(); setZoom(pinch.z0 * dist(e.touches) / pinch.d0); }
}, { passive: false });
$("cam").addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ---- torch
function renderTorch() {
  const caps = S.videoTrack.getCapabilities ? S.videoTrack.getCapabilities() : {};
  $("torch").hidden = !caps.torch;
  $("torch").classList.toggle("on", !!S.videoTrack.getSettings().torch);
}
$("torch").onclick = async () => {
  const on = !S.videoTrack.getSettings().torch;
  try { await S.videoTrack.applyConstraints({ advanced: [{ torch: on }] }); } catch (e) { toast("Torch: " + e.message); }
  renderTorch();
};

// ---- fixed lenses (settings)
function renderLenses() {
  const box = $("lenses"); box.innerHTML = "";
  const cams = S.devices.filter(d => d.kind === "videoinput" && !/dual|triple/i.test(d.label));
  const auto = document.createElement("button");
  auto.textContent = "Auto (pinch zoom)";
  auto.classList.toggle("sel", !S.fixedLensId && S.facing === "back");
  auto.onclick = async () => { S.fixedLensId = null; S.facing = "back"; await setVideoDevice(S.backId).catch(e => toast(e.message)); };
  box.appendChild(auto);
  const cur = S.videoTrack && S.videoTrack.getSettings().deviceId;
  for (const d of cams) {
    const b = document.createElement("button");
    b.textContent = d.label.replace(/ camera$/i, "");
    b.classList.toggle("sel", !!S.fixedLensId && d.deviceId === cur);
    b.onclick = async () => {
      const front = /front/i.test(d.label);
      S.fixedLensId = front ? null : d.deviceId; S.facing = front ? "front" : "back";
      await setVideoDevice(d.deviceId).catch(e => toast(e.message));
    };
    box.appendChild(b);
  }
}

// ---- microphone
function renderMics() {
  const sel = $("mic"); sel.innerHTML = "";
  const cur = S.audioTrack && S.audioTrack.getSettings().deviceId;
  for (const d of S.devices.filter(d => d.kind === "audioinput")) {
    const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || "Microphone";
    o.selected = d.deviceId === cur; sel.appendChild(o);
  }
}
$("mic").onchange = async (e) => {
  try {
    const nt = (await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: e.target.value } } })).getAudioTracks()[0];
    nt.enabled = !S.micMuted && !S.brb;
    const sender = audioSender();
    if (sender) await sender.replaceTrack(nt);
    if (S.audioTrack) S.audioTrack.stop();
    S.audioTrack = nt;
  } catch (err) { toast("Mic switch failed: " + err.message); }
};
$("mute").onclick = () => {
  S.micMuted = !S.micMuted;
  if (S.audioTrack) S.audioTrack.enabled = !S.micMuted && !S.brb;
  $("mute").classList.toggle("off", S.micMuted);
  $("mute").textContent = S.micMuted ? "🔇" : "🎤";
};
navigator.mediaDevices && navigator.mediaDevices.addEventListener("devicechange", async () => {
  await refreshDevices(); renderMics();
});

// ---- wake lock
async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || S.wakeLock) return;
  try { S.wakeLock = await navigator.wakeLock.request("screen"); S.wakeLock.onrelease = () => { S.wakeLock = null; }; } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.loggedIn) {
    acquireWakeLock();
    // iOS ends camera tracks when the page is backgrounded; bring them back.
    if (S.videoTrack && S.videoTrack.readyState === "ended") {
      setVideoDevice(S.facing === "front" ? S.frontId : (S.fixedLensId || S.backId)).catch(() => {});
    }
    if (S.audioTrack && S.audioTrack.readyState === "ended") $("mic").dispatchEvent(new Event("change"));
  }
});

// ------------------------------------------------------------------ be right back
// Paused, or the camera is gone: the video sender is switched to a canvas that
// fades from the camera to the BRB picture, and the mic is
// muted. If the phone itself drops off, the relay shows the same picture
// (server/brb-stream.js) until the phone is back.
const FADE_MS = 400; // camera <-> BRB picture cross-fade
const BRB = (() => {
  const imgs = {};
  for (const o of ["landscape", "portrait"]) { const i = new Image(); i.src = `brb/${o}.webp`; imgs[o] = i; }
  let canvas = null, ctx = null, track = null, timer = null, fade = null, orient = "landscape", alpha = 0, lastDraw = 0;

  // Shape of the frames being sent. Remembered, because a camera that has
  // just cut out may report no size at all.
  let lastCamOrient = "landscape";
  const camOrient = () => {
    const v = $("preview");
    if (v.videoWidth && v.videoHeight) lastCamOrient = v.videoHeight > v.videoWidth ? "portrait" : "landscape";
    return lastCamOrient;
  };
  function drawCamera(c, W, H) {
    const v = $("preview");
    c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    if (!v.videoWidth) return;
    const s = Math.max(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s;
    try { c.drawImage(v, (W - w) / 2, (H - h) / 2, w, h); } catch {}
  }
  function frame() {
    if (!S.brb || !ctx) return;
    const now = performance.now();
    let done = null;
    if (fade) {
      const p = Math.min(1, (now - fade.t0) / fade.ms);
      alpha = fade.from + (fade.to - fade.from) * p;
      if (p >= 1) { done = fade.then; fade = null; }
    }
    const img = imgs[orient].complete && imgs[orient].naturalWidth ? imgs[orient] : null;
    // While fading, every frame; after that the picture is static, but keep
    // redraw it once a second so the stream keeps sending frames.
    if (fade || done || alpha < 1 || now - lastDraw > 1000) {
      lastDraw = now;
      gikocamBrb.draw(ctx, orient, img, alpha, alpha < 1 ? drawCamera : null);
    }
    if (done) done();
  }
  async function enter(reason) {
    if (S.brb) {
      if (reason === "pause") S.brb.reason = "pause";
      if (S.brb.leaving) { S.brb.leaving = false; fade = { from: alpha, to: 1, t0: performance.now(), ms: FADE_MS }; }
      return setStatus();
    }
    S.brb = { since: Date.now(), reason };
    orient = camOrient();
    const [W, H] = gikocamBrb.SIZES[orient];
    canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    ctx = canvas.getContext("2d");
    alpha = 0; lastDraw = 0; fade = { from: 0, to: 1, t0: performance.now(), ms: FADE_MS };
    frame();
    track = canvas.captureStream(30).getVideoTracks()[0];
    timer = setInterval(frame, 33);
    if (S.audioTrack) S.audioTrack.enabled = false;
    const snd = videoSender();
    if (snd) await snd.replaceTrack(track).catch(() => {});
    setStatus();
  }
  function exit() {
    if (!S.brb || S.brb.leaving) return;
    const cam = S.videoTrack;
    if (!cam || cam.readyState !== "live" || cam.muted) { toast("The camera isn't back yet"); S.brb.reason = "camera"; return setStatus(); }
    S.brb.leaving = true;
    fade = { from: alpha, to: 0, t0: performance.now(), ms: FADE_MS, then: finish };
  }
  async function finish() {
    if (!S.brb || !S.brb.leaving) return;
    const snd = videoSender();
    if (snd && S.videoTrack) await snd.replaceTrack(S.videoTrack).catch(() => {});
    stop();
  }
  function stop() {
    clearInterval(timer); timer = null;
    if (track) track.stop();
    canvas = ctx = track = null; fade = null;
    if (!S.brb) return;
    S.brb = null;
    if (S.audioTrack) S.audioTrack.enabled = !S.micMuted;
    setStatus();
  }
  return { enter, exit, stop, track: () => (S.brb && track) || null, orient: () => (S.brb ? orient : camOrient()) };
})();

$("brbBtn").onclick = () => { if (S.brb) BRB.exit(); else BRB.enter("pause"); };

// Heartbeat: lets the relay notice within seconds when the phone drops off
// while live, and cover for it with the BRB stream.
setInterval(() => {
  if (!S.loggedIn) return;
  send({ t: "hb", live: S.wantLive && S.slot !== null, orient: BRB.orient() });
}, 2000);

function onBrbHandback(slot) {
  // The relay was showing the BRB stream in our slot and has just stopped it;
  // request the same slot again.
  if (!S.wantLive || S.streamState === "requesting") return;
  sysMsg("Reconnected: back on air");
  closePeer(); S.peerRetry = 0; S.slot = null;
  requestStream(Number.isInteger(slot) ? slot : null);
}

// ------------------------------------------------------------------ streaming
$("live").onclick = () => {
  if (S.wantLive) stopStream(); else { S.wantLive = true; requestStream(); }
  setStatus();
};

function requestStream(preferSlot = null) {
  if (!S.wantLive || S.pc || S.streamState === "requesting") return;
  const slot = Number.isInteger(preferSlot) ? preferSlot : S.streams.findIndex(s => !s.isActive);
  if (slot < 0) {
    toast(S.streams.length ? "Every stream slot in this room is taken" : "This room has no stream slots. Pick another room.", 4000);
    S.wantLive = false; setStatus();
    $("roomBtn").click();
    return;
  }
  S.slot = slot; S.streamState = "requesting";
  setTimeout(() => {
    if (S.streamState === "requesting" && !S.pc) {
      sysMsg("gikopoipoi didn't answer the stream request, retrying");
      S.streamState = "off"; S.slot = null; requestStream();
    }
  }, 10000);
  emit("user-want-to-stream", {
    streamSlotId: slot, withVideo: true, withSound: true,
    isVisibleOnlyToSpecificUsers: false, streamIsVtuberMode: false, isNicoNicoMode: false,
    info: [S.audioTrack, S.videoTrack].filter(Boolean).map(t => ({
      constraints: t.getConstraints && t.getConstraints(), settings: t.getSettings && t.getSettings(),
    })),
  });
  setStatus();
}

function startPeer() {
  closePeer(false);
  const pc = new RTCPeerConnection(ICE);
  S.pc = pc; S.streamState = "connecting";
  pc.addEventListener("negotiationneeded", async () => {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      S.pendingOffer = offer.sdp;
      emit("user-rtc-message", { streamSlotId: S.slot, type: "offer", msg: offer.sdp });
    } catch (e) { sysMsg("Offer failed: " + e.message); restartPeer(); }
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    const st = pc.iceConnectionState;
    if (st === "connected" || st === "completed") {
      S.streamState = "live"; S.peerRetry = 0; applyBitrate(); setStatus();
    } else if (st === "disconnected") {
      S.streamState = "reconnecting"; setStatus();
      // Mobile data hiccup; give ICE a few seconds to recover by itself.
      setTimeout(() => { if (S.pc === pc && pc.iceConnectionState === "disconnected") restartPeer(); }, 6000);
    } else if (st === "failed") restartPeer();
  });
  const ms = new MediaStream([BRB.track() || S.videoTrack, S.audioTrack].filter(Boolean));
  for (const t of ms.getTracks()) pc.addTrack(t, ms);
  setStatus();
}

async function onRtcMessage(slotId, type, msg) {
  const pc = S.pc;
  if (!pc || slotId !== S.slot) return;
  try {
    if (type === "answer" && typeof msg === "string") {
      if (S.pendingOffer) { await pc.setLocalDescription({ type: "offer", sdp: S.pendingOffer }); S.pendingOffer = null; }
      await pc.setRemoteDescription({ type: "answer", sdp: msg });
    } else if (type === "offer" && typeof msg === "string") {
      await pc.setRemoteDescription({ type: "offer", sdp: msg });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      emit("user-rtc-message", { streamSlotId: S.slot, type: "answer", msg: answer.sdp });
    } else if (type === "candidate" && msg) {
      await pc.addIceCandidate(msg);
    }
  } catch (e) { sysMsg("RTC error: " + e.message); restartPeer(); }
}

function restartPeer() {
  if (!S.wantLive) return closePeer();
  closePeer(false);
  S.streamState = "reconnecting"; setStatus();
  const wait = Math.min(15000, 1000 * 2 ** S.peerRetry++);
  // Same slot, new peer connection, like the official client's reconnect.
  setTimeout(() => { if (S.wantLive && !S.pc && S.slot !== null) startPeer(); }, wait);
}

function closePeer(resetState = true) {
  if (S.pc) { S.pc.close(); S.pc = null; }
  S.pendingOffer = null;
  if (resetState) S.streamState = "off";
}

function stopStream() {
  S.wantLive = false;
  BRB.stop();
  emit("user-want-to-stop-stream");
  closePeer(); S.slot = null;
  setStatus();
}

const videoSender = () => S.pc && S.pc.getSenders().find(s => s.track && s.track.kind === "video");
const audioSender = () => S.pc && S.pc.getSenders().find(s => s.track && s.track.kind === "audio");

async function applyBitrate() {
  const sender = videoSender(); if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
  p.encodings[0].maxBitrate = +$("quality").value;
  try { await sender.setParameters(p); } catch {}
}
$("quality").value = String(store.get("quality", 1000000));
$("quality").onchange = () => { store.set("quality", +$("quality").value); applyBitrate(); };

// ---- settings sheet + live stats
$("settingsBtn").onclick = () => { $("settingsPanel").hidden = false; renderMics(); renderLenses(); };
$("logout").onclick = () => {
  store.set("session", null);
  if (S.wantLive) stopStream();
  send({ t: "logout" }); S.loggedIn = false;
  if (S.ws) S.ws.close();
  stopCamera();
  location.reload();
};
let lastBytes = 0, lastTs = 0;
setInterval(async () => {
  if ($("settingsPanel").hidden) return;
  const lines = [];
  const vs = S.videoTrack ? S.videoTrack.getSettings() : {};
  lines.push(`camera  ${S.videoTrack ? S.videoTrack.label : "-"} ${vs.width || "?"}x${vs.height || "?"} zoom ${(+currentZoom()).toFixed(2)}`);
  lines.push(`relay   ${S.ws && S.ws.readyState === 1 ? "connected" : "down"}   stream ${S.streamState}${S.slot !== null ? " (slot " + S.slot + ")" : ""}`);
  const sender = videoSender();
  if (sender) {
    const stats = await sender.getStats();
    stats.forEach(r => {
      if (r.type === "outbound-rtp" && r.kind === "video") {
        const kbps = lastTs ? ((r.bytesSent - lastBytes) * 8 / (r.timestamp - lastTs)) | 0 : 0;
        lastBytes = r.bytesSent; lastTs = r.timestamp;
        lines.push(`sending ${kbps} kbps  ${r.frameWidth || "?"}x${r.frameHeight || "?"} @ ${r.framesPerSecond || "?"}fps  limit: ${r.qualityLimitationReason || "-"}`);
      }
    });
  }
  $("stats").textContent = lines.join("\n");
}, 1000);

// Closing the page does not end the stream: like losing signal, the relay puts
// up the BRB screen and the next visit can Rejoin. End stream / Leave end it.

initLogin();
checkOldSession();
