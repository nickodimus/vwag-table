/* sync.js — the GM↔player sync layer (BroadcastChannel).
 * Serializes board state, view, and assets and posts them to the channel; applies incoming view
 * updates; snaps and reports player viewports; relays messages. The frame draw runs through the hub
 * render hook. The incoming-message dispatcher (handleMessage) stays in app.js — it wires messages to
 * app.js handlers, like bindControls wires the UI.
 */

import {
  canvas, channel, controls, hooks, isPlayer, state, tools, ui, uuid,
  peerWindow,
} from "./state.js";
import {
  captureCurrentFloor,
} from "./persistence.js";
import {
  getToken,
} from "./api.js";

let viewSyncQueued = false; // debounce flag: at most one view broadcast queued per animation frame

// Player -> GM: report this display's pixel size so the GM can draw the "player frame".
function reportPlayerViewport() {
  if (!isPlayer) return;
  const rect = canvas.getBoundingClientRect();
  relay({ type: "viewport", w: rect.width, h: rect.height });
}

// Send a message over both transports. BroadcastChannel reaches any same-origin window;
// the direct postMessage reaches the opener/popup even when BroadcastChannel does not.
function relay(message) {
  message.mid = uuid();
  try {
    channel.postMessage(message);
  } catch {}
  const target = isPlayer ? window.opener : peerWindow.ref;
  if (target && !target.closed) {
    try {
      target.postMessage(message, "*");
    } catch {}
  }
  if (socketReady && socket) {
    try {
      socket.send(JSON.stringify(message));
    } catch {}
  }
}

// ── network relay (online tier, Chunk 2): a third transport ──────────────────
// BroadcastChannel + postMessage reach same-machine windows only. To link the GM
// to a remote player (another machine), we ALSO open a WebSocket to fallon's
// stateless hub. The URL mirrors api.js's FALLON_BASE: the public TLS path when
// served from game.worhl.net, the direct LAN address otherwise (so the local GM
// on jedas reaches uvicorn directly). Both land on the same /ws hub + room.
//
// Auth is in-band: on open we send { type:"auth", token }. getToken() returns the
// GM's unique_key (once logged in) or the guest token (seated by adoptStoredGuest
// on the player view). No token yet (GM not logged in) -> we hold off and retry
// rather than churn sockets. A dropped socket reconnects and re-auths, so a flaky
// remote link self-heals — the cloud-dependent weakness we beat.

let socket = null;
let socketReady = false;
let relayOnMessage = null;     // main.js's handleMessage, wired at connectRelay()
let reconnectTimer = null;

function _relayWsUrl() {
  return window.location.hostname === "game.worhl.net"
    ? `wss://${window.location.host}/ws`
    : "ws://10.10.0.10:8002/ws";
}

function _scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    _openSocket();
  }, 3000);
}

function _openSocket() {
  const token = getToken();
  if (!token) {                 // no identity yet (e.g. GM not logged in) — wait, don't churn
    _scheduleReconnect();
    return;
  }
  let ws;
  try {
    ws = new WebSocket(_relayWsUrl());
  } catch {
    _scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: "auth", token }));
    } catch {
      try { ws.close(); } catch {}
      return;
    }
    socketReady = true;
    // Announce so the GM pushes a full sync to this player over the relay — the
    // same handshake local play uses. The GM announces nothing.
    if (isPlayer) relay({ type: "player-ready" });
  };

  ws.onmessage = (event) => {
    if (!relayOnMessage) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    relayOnMessage(msg, null);
  };

  ws.onclose = () => {
    socketReady = false;
    if (socket === ws) socket = null;
    _scheduleReconnect();
  };

  ws.onerror = () => { try { ws.close(); } catch {} };   // onclose schedules the retry
}

// Called once from main.js setup() with the inbound dispatcher (handleMessage).
// Opens the relay socket for both GM and player; in local-only play with no
// remote peer it simply never carries a frame, which is harmless.
function connectRelay(onMessage) {
  relayOnMessage = onMessage;
  _openSocket();
}

function applyRemoteView(message) {
  if (message.view) Object.assign(state.view, message.view);
  if (message.playerView) {
    if (isPlayer) applyIncomingPlayerView(message.playerView);
    else Object.assign(state.playerView, message.playerView);
  }
  if (message.aoe) {
    tools.aoe.template.visible = message.aoe.visible;
    if (message.aoe.visible) {
      tools.aoe.template.x = message.aoe.x;
      tools.aoe.template.y = message.aoe.y;
      tools.aoe.shape = message.aoe.shape;
      tools.aoe.sizeFt = message.aoe.sizeFt;
      tools.aoe.angle = message.aoe.angle;
      tools.aoe.color = message.aoe.color;
    }
  }
  hooks.render();
}

// Player side: the player display is fully GM-driven, so it adopts whatever playerView
// the GM sends (framing + rotation), then re-derives its own on-screen scale by fitting
// the broadcast region to THIS device (refitFramedView).
function applyIncomingPlayerView(pv) {
  Object.assign(state.playerView, pv);
  state.playerView.frameScale = pv.scale; // the GM's region-defining scale (pre-fit)
  refitFramedView();                       // derive THIS device's fitted render scale
}

// Player: fit the GM's broadcast region (the red box — the frameRef world-rectangle at
// frameScale) to this device's own canvas. Every device fits the SAME region, so the
// framing is identical across phone / laptop / TV; a smaller screen just shows it more
// zoomed out (letterboxed where the aspect differs). The map.scale cancels, so it reduces
// to base * fit-factor. Re-run on every framing update (here) and on this device's own
// resize (main.js's canvas watcher).
function refitFramedView() {
  if (!isPlayer) return;
  const ref = state.playerView.frameRef;
  const base = state.playerView.frameScale;
  if (!ref || !ref.w || !ref.h || !base) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  state.playerView.scale = base * Math.min(rect.width / ref.w, rect.height / ref.h) * 0.96;
}

function syncPlayerViewControls() {
  controls.playerMatchDM.checked = state.playerView.matchDM;
  const v = state.playerView.matchDM ? state.view : state.playerView;
  controls.playerZoom.value = v.scale;
  controls.playerOffsetX.value = v.cx;
  controls.playerOffsetY.value = v.cy;
}

// One-shot copy of the GM's current framing onto the player view. Intentionally does
// NOT change the "Follow GM" toggle (matchDM) — clicking the button just snaps the
// player view once and leaves the follow mode as the user set it.
function snapPlayerViewToGM(sync) {
  state.playerView.scale = state.view.scale;
  state.playerView.cx = state.view.cx;
  state.playerView.cy = state.view.cy;
  state.playerView.rotation = state.view.rotation;
  syncPlayerViewControls();
  hooks.render();
  if (sync) broadcastState();
}

function broadcastAssets() {
  if (isPlayer || ui.roaming) return;
  // The table shows the active floor. When it's pinned to a floor the GM isn't viewing, send that
  // floor's image — records carry their bytes at runtime (hydrateFloorImages). When the table
  // follows the GM (the common case), the live current-floor image is freshest, so use it.
  const active = state.floors.find((f) => f.id === state.activeFloorId);
  const onCurrent = !active || active.id === state.currentFloorId;
  relay({
    type: "assets",
    imageId: onCurrent ? state.imageId : (active.imageId || ""),
    imageData: onCurrent ? state.imageData : (active.imageData || ""),
    imageName: onCurrent ? state.imageName : (active.imageName || ""),
    splash: { imageData: state.splash.imageData, imageName: state.splash.imageName },
  });
}

// Sent on settings/fog/token changes. The player only needs the ACTIVE floor's live
// fields (which sit at the top level of state), so we omit the whole floor stack and
// the current image. Omitting (not blanking) the image means this never clobbers the
// image the player already received via the separate "assets" message.
function sanitizedState() {
  captureCurrentFloor();
  const { floors, imageData, ...rest } = state;
  const clone = JSON.parse(JSON.stringify(rest));
  if (clone.splash) delete clone.splash.imageData;
  delete clone.notes; // floating notes are GM-only and never leave the GM window
  // The players' table shows the ACTIVE floor, which differs from the GM's current view while the
  // table is pinned. captureCurrentFloor() above flushed the live floor into its record, so every
  // record (the active one included) is current; override the live-mirror fields with the active
  // floor's record so the table keeps rendering its own floor while the GM roams elsewhere.
  const activeIdx = floors.findIndex((f) => f.id === state.activeFloorId);
  const active = floors[activeIdx] || floors.find((f) => f.id === state.currentFloorId) || floors[0];
  clone.imageId = active.imageId || "";
  clone.imageName = active.imageName || "";
  clone.imageWidth = active.imageWidth || 0;
  clone.imageHeight = active.imageHeight || 0;
  clone.map = { ...(clone.map || {}), scale: active.mapScale || 1 };
  clone.fog = { ...(clone.fog || {}), rooms: active.rooms || [], strokes: active.strokes || [] };
  clone.tokens = active.tokens || [];
  clone.stairs = active.stairs || [];
  clone.obstacles = active.obstacles || [];
  clone.lights = active.lights || [];
  clone.aoes = active.aoes || [];
  clone.images = active.images || [];
  clone.mapLinks = active.mapLinks || []; // travel points — players see the markers to navigate; descend stays GM-only
  clone.view = active.view ? { ...active.view } : clone.view;
  // Names-only "rest of party" summary: every OTHER floor (vs the active/table floor) that holds
  // player tokens. No total, no table-floor name, no position — the player learns WHERE split-off
  // teammates are without learning how deep the dungeon runs. Battlemaps only — world/town maps have
  // no floors, and the player shows a party roster there instead (refreshPartyRoster).
  clone.floorSummary = state.mapKind === "battle"
    ? floors
      .map((f, i) => ({ i, name: f.name, players: (f.tokens || []).filter((t) => t.type === "player").length }))
      .filter((f) => f.i !== activeIdx && f.players > 0)
      .map((f) => ({ name: f.name && f.name.trim() ? f.name : "another floor", players: f.players }))
    : [];
  return clone;
}

function broadcastState() {
  if (isPlayer || ui.roaming) return; // while the GM roams to another map for prep, the table stays put
  relay({ type: "sync", state: sanitizedState() });
}

// Lightweight view-only message, coalesced to one per frame for smooth pan/zoom.
function broadcastView() {
  if (isPlayer || ui.roaming) return;
  if (viewSyncQueued) return;
  viewSyncQueued = true;
  requestAnimationFrame(() => {
    viewSyncQueued = false;
    relay({
      type: "view",
      view: { ...state.view },
      playerView: { ...state.playerView },
      aoe: {
        visible: tools.aoe.template.visible,
        x: tools.aoe.template.x,
        y: tools.aoe.template.y,
        shape: tools.aoe.shape,
        sizeFt: tools.aoe.sizeFt,
        angle: tools.aoe.angle,
        color: tools.aoe.color,
      },
    });
  });
}

function renderAndSync() {
  hooks.render();
  broadcastState();
}

function renderAndSyncView() {
  hooks.render();
  broadcastView();
}

export {
  reportPlayerViewport, relay, applyRemoteView, applyIncomingPlayerView, syncPlayerViewControls, snapPlayerViewToGM, broadcastAssets, broadcastState,
  broadcastView, renderAndSync, renderAndSyncView, sanitizedState, connectRelay, refitFramedView,
};
