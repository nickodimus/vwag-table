/* sync.js — the GM↔player sync layer (BroadcastChannel).
 * Serializes board state, view, and assets and posts them to the channel; applies incoming view
 * updates; snaps and reports player viewports; relays messages. The frame draw runs through the hub
 * render hook. The incoming-message dispatcher (handleMessage) stays in app.js — it wires messages to
 * app.js handlers, like bindControls wires the UI.
 */

import {
  canvas, channel, controls, hooks, isPlayer, state, tools, uuid,
  peerWindow,
} from "./state.js";
import {
  captureCurrentFloor,
} from "./persistence.js";

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

// Player side: the player display is fully GM-driven, so it just adopts whatever
// playerView the GM sends (framing + rotation).
function applyIncomingPlayerView(pv) {
  Object.assign(state.playerView, pv);
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
  if (isPlayer) return;
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
  if (isPlayer) return;
  relay({ type: "sync", state: sanitizedState() });
}

// Lightweight view-only message, coalesced to one per frame for smooth pan/zoom.
function broadcastView() {
  if (isPlayer) return;
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
  broadcastView, renderAndSync, renderAndSyncView, sanitizedState,
};
