/* Battlemap Screen and GM Streaming Tool
 * Coordinate model:
 *   - "native" coords are image pixels (0..imageWidth, 0..imageHeight). Fog, rooms,
 *     tokens, pings and measures are all stored in native coords so they stay glued to
 *     the map regardless of zoom or the "Map image size" (map.scale) slider.
 *   - The render transform maps native -> world (x map.scale) -> screen (x view.scale,
 *     centered on view.cx/cy). Because the view is expressed as a centered map point +
 *     zoom, the GM and player windows frame the same thing even at different canvas sizes.
 */


import {
  canvas, ctx, fogCanvas, fogCtx, liveCanvas, liveCtx, polyCanvas, polyCtx,
  strokeCanvas, strokeCtx, losCanvas, losCtx, darkCanvas, darkCtx, lightCanvas, lightCtx,
  exploredMasks, lightCache, shell, emptyState, channel, APP_NAME, LEGACY_APP_NAME, SAVE_FILE_VERSION,
  DB_NAME, DB_VERSION, MAP_STORE, IMAGE_STORE, MODULE_STORE, SESSION_STORE, TOKEN_STORE, FOG_MAX_EDGE,
  HISTORY_LIMIT, STAIRS_ICON_NEUTRAL, STAIRS_ICON_UP, STAIRS_ICON_DOWN, FEET_PER_CELL, MEASURE_UNITS, PING_DURATION, controls,
  CONDITIONS,
  MAP_LINK_ICONS, MAP_LINK_DEFAULT_ICON, MAP_KIND_CAPS,
  isPlayer, DEFAULT_GM_FOG_OPACITY, INITIAL_FLOOR_ID, makeFloor, state, normalizeInput, uuid, escapeHtml,
  playerCam, tools, cur, hooks, sel, fogBuf, peerWindow,
  castCache, castFrameKeys, lightFrameKeys,
  ui,
  scene,
} from "./state.js";
import {
  saveMapRecord, listMapRecords, deleteMapRecord, saveModuleRecord, listModuleRecords, getModuleRecord, deleteModuleRecord, saveSessionRecord,
  listSessionRecords, getSessionRecord, deleteSessionRecord, saveTokenRecord, listTokenRecords, deleteTokenRecord, putImage, getImageRecord,
  getImage,
} from "./db.js";
import { readZip, parseDtt, importDtt } from "./dtt.js";
import {
  simplifyPolyline, distToSegment, pointInPolygon, gridCellNative, pxPerCellNative, cellsToNative, tokenRadius, snapToGrid,
  snapNative, worldDims, activeView, fitScaleFor, viewTransform, clientToCanvasPoint, currentViewRotation, keepUpright,
  screenToNative, nativeToScreen, followView, cellWorldPx,
} from "./geometry.js";
import {
  drawAoeTemplate, drawMeasureLine, drawMeasureLabel, drawCalibrationDraft, updateCalibrationUI, updateMeasureCalibrateRow, hitAoe,
} from "./aoe-measure.js";
import {
  drawNotes, hitNote, drawImages, hitImage, snapImage, getTokenImage, addPing, drawPings,
} from "./annotations.js";
import {
  sortedCombatants, activeTurnTokenId, clampInitiativeTurn, updateInitiativeUI,
} from "./initiative.js";
import {
  rebuildFog, compositeFog, roomPathFog, polygonCentroid, drawStampDraft, drawPolygon, stampPolygon, addInterpolatedStrokePoints,
} from "./fog.js";
import {
  invalidateCast, rayHit, getVisibilityPolygon, hitLight, drawLights, compositeLoS, castVersion,
} from "./vision.js";
import {
  tokenIsSquare, drawTokens,
} from "./tokens.js";
import {
  drawRoomOutlines, drawObstacleOutlines, drawDraftObstacle, drawRoomNames, drawDraftRoom, obstacleDefaults, hitObstacle, moveSegments,
} from "./rooms-obstacles.js";
import {
  ensureCameraLoop, stopCameraLoop, rotateMap,
} from "./view.js";
import {
  hydrateFloorImages, mergeModuleSession, migrateMapsToModulesAndSessions, captureCurrentFloor, splitState, makeMapId, deriveCellGrid,
  snapshotFromLiveState,
} from "./persistence.js";
import {
  resolveSession, resolveModule, resolveImage,
  trailActiveId, trailDepth, trailPush, trailPop,
  cacheHas, cacheGet, cacheSet,
} from "./content.js";
import {
  reportPlayerViewport, relay, applyRemoteView, applyIncomingPlayerView, syncPlayerViewControls, snapPlayerViewToGM, broadcastAssets, broadcastState,
  broadcastView, renderAndSync, renderAndSyncView,
} from "./sync.js";
import {
  render, playerFrameCorners,
} from "./render.js";
import {
  apiFetch, isLoggedIn,
} from "./api.js";
async function saveSession() {
  captureCurrentFloor();
  if (!state.floors.some((floor) => floor.imageData)) {
    window.alert("Load a map image before saving.");
    return;
  }

  const suggestedName = state.imageName ? state.imageName.replace(/\.[^.]+$/, "") : "battlemap";
  const enteredName = window.prompt("Save map as:", suggestedName);
  const mapName = enteredName?.trim();
  if (!mapName) return;

  // Make sure every floor that has an image carries a stable id (on the live state, so future
  // saves reuse it and the image store stays deduped), then mirror the current one up.
  state.floors.forEach((floor) => {
    if (floor.imageData && !floor.imageId) floor.imageId = uuid();
  });
  const currentFloor = state.floors.find((f) => f.id === state.currentFloorId);
  if (currentFloor && currentFloor.imageId) state.imageId = currentFloor.imageId;

  try {
    // De-embed: each floor's image into the image store (step 1), keyed by imageId.
    for (const floor of state.floors) {
      if (floor.imageData && floor.imageId) await putImage(floor.imageId, floor.imageData);
    }
    // Split the live state into an authored module + a session that references it. 1:1 for now:
    // module and session share the name-derived id, which preserves overwrite-by-name, while the
    // two-store + moduleId reference is already 1:many-ready.
    const id = makeMapId(mapName);
    const now = new Date().toISOString();
    const { module, session } = splitState(state);
    Object.assign(module, { id, app: APP_NAME, version: SAVE_FILE_VERSION, kind: "module", name: mapName, savedAt: now });
    Object.assign(session, { id, moduleId: id, app: APP_NAME, version: SAVE_FILE_VERSION, kind: "session", name: mapName, savedAt: now });
    await saveModuleRecord(module);
    await saveSessionRecord(session);
    window.alert(`Saved "${mapName}" to the local map library.`);
    refreshLibraryButtonState();
  } catch (error) {
    window.alert(`Could not save this map: ${error.message}`);
  }
}













async function deleteLibraryMap(id, name) {
  if (!window.confirm(`Delete "${name}" from the local map library?`)) return;
  const session = await getSessionRecord(id);
  await deleteSessionRecord(id);
  // 1:1 — drop the referenced module too. (Its image blob is left in the image store; orphan
  // cleanup is a separate backlog chunk so a shared image is never nuked out from under another
  // map.)
  await deleteModuleRecord(session?.moduleId || id);
  const sessions = await listSessionRecords();
  renderLibraryList(sessions);
  refreshLibraryButtonState(sessions);
}

function importLibrary(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const images = Array.isArray(parsed?.images) ? parsed.images : [];
      const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];
      const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      // Legacy exports are a bare array, {maps:[...]}, or {maps, images} — single records.
      const legacyMaps = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.maps) ? parsed.maps : []);
      if (!modules.length && !sessions.length && !legacyMaps.length) {
        throw new Error("no maps found in that file");
      }
      // Restore images first so module records can reference them.
      for (const image of images) {
        if (image?.id && image?.data) await putImage(image.id, image.data);
      }
      let imported = 0;
      for (const module of modules) {
        if (module?.id) await saveModuleRecord(module);
      }
      for (const session of sessions) {
        if (session?.id) {
          await saveSessionRecord(session);
          imported += 1;
        }
      }
      // Legacy single-record maps: store them, then split into module + session pairs.
      for (const record of legacyMaps) {
        if (!record?.id || !record?.state) continue;
        await saveMapRecord(record);
      }
      if (legacyMaps.length) {
        await migrateMapsToModulesAndSessions();
        imported += legacyMaps.length;
      }
      window.alert(`Imported ${imported} map${imported === 1 ? "" : "s"}.`);
      const updated = await listSessionRecords();
      renderLibraryList(updated);
      refreshLibraryButtonState(updated);
    } catch (error) {
      window.alert(`Could not import that file: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}







// Wire the orchestration hooks now that the render/sync/relay functions exist (all hoisted).
hooks.render = render;
hooks.renderAndSync = renderAndSync;
hooks.relay = relay;

// Area of effect is a live "hover template" (not placed): the shape follows the cursor
// and is mirrored to the player display in real time.
let aoeSyncQueued = false;
const AOE_PRESETS = { circle: [5, 10, 15, 20], square: [10, 20, 30], cone: [15, 30] };
let tokenImageData = ""; // image applied to newly placed tokens (data URL), authoring default

// --- Token palette: a browsable library of reusable token templates (TOKEN_STORE) ---
let paletteEntries = []; // in-memory mirror of the persisted palette
let activePaletteId = null; // entry whose template is currently loaded into the token controls
let paletteThumbPx = 64; // browse size for palette thumbnails, persisted to localStorage
const PALETTE_THUMB_KEY = "vwag-table-palette-thumb";
const IMAGE_MAX_EDGE = 1024; // cap dropped map images so saves/syncs stay bounded
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let viewStart = { cx: 0, cy: 0 };
let draggingToken = null;
let draggingImage = null;
let draggingNote = null;
let draggingStair = null;
let draggingMapLink = null;
let mapLinkIconChoice = MAP_LINK_DEFAULT_ICON; // current pick in the place-map-link dialog
let draggingFrame = false; // GM is dragging the player-view frame to pan the player display
let dragGrab = { dx: 0, dy: 0 }; // offset from cursor to object center while dragging images/notes/frame
let groupDragOffsets = null; // [{token,dx,dy}] formation captured at grab, for a player group-drag
let dragGrabbed = false; // a token-grab has been relayed for the current player pointer-drag
let dragMeasureStart = null; // the dragged token's pre-drag position; anchors the live drag-distance line

const undoStack = [];
const redoStack = [];

let seenMids = []; // recently handled message ids, for de-duplicating the two transports
// IRL play: keep one grid square a constant physical size on the player screen (TV). The
// target is screen px per square; the player zoom is re-derived per map from its grid size.
let lockPlayerSquare = false;
let lockedSquarePx = 0;
const SQUARE_LOCK_KEY = "lodestar.squareLock";

function handleMessage(message, source) {
  if (!message || typeof message !== "object") return;
  if (message.mid) {
    if (seenMids.includes(message.mid)) return;
    seenMids.push(message.mid);
    if (seenMids.length > 60) seenMids.shift();
  }
  if (message.type === "assets" && isPlayer) applyAssets(message);
  if (message.type === "sync" && isPlayer) loadSnapshot(message.state);
  if (message.type === "view" && isPlayer) applyRemoteView(message);
  if (message.type === "ping") addPing(message.x, message.y, message.color);
  if (message.type === "measure" && isPlayer) {
    tools.measureLine = message.line;
    render();
  }
  if (message.type === "reset-explored" && isPlayer) {
    resetExplored();
    render();
  }
  if (message.type === "player-ready" && !isPlayer) {
    if (source) peerWindow.ref = source;
    broadcastAssets();
    broadcastState();
  }
  if (message.type === "request-assets" && !isPlayer) broadcastAssets();
  if (message.type === "viewport" && !isPlayer) {
    ui.playerViewport = { w: message.w, h: message.h };
    render();
  }
  if (message.type === "token-grab" && !isPlayer) {
    // Snapshot once at the start of a remote drag so the whole move is one undo step — but only when
    // the table follows the GM's view. A drag on a floor the GM isn't viewing (table pinned
    // elsewhere) shouldn't land on the GM's local undo stack.
    if (state.activeFloorId === state.currentFloorId) pushHistory();
  }
  if (message.type === "token-move" && !isPlayer) {
    // Live position during a drag: update and render locally, but do NOT broadcast — a full state
    // sync mid-drag would replace the player's tokens and orphan its drag.
    if (state.activeFloorId !== state.currentFloorId) {
      // Table pinned to another floor: update the token in the active floor's record. No GM render
      // (the GM isn't viewing it) and no broadcast (the player previews its own drag locally).
      const active = state.floors.find((f) => f.id === state.activeFloorId);
      const token = active && (active.tokens || []).find((t) => t.id === message.id);
      if (token) { token.x = message.x; token.y = message.y; }
    } else {
      const token = state.tokens.find((t) => t.id === message.id);
      if (token) {
        token.x = message.x;
        token.y = message.y;
        render();
      }
    }
  }
  if (message.type === "token-drop" && !isPlayer) {
    // Commit a player move: pick the target cell (nudged to the nearest free one so no two tokens
    // share a cell), clamp the move to it so it can't cross a wall, then broadcast to all displays.
    // The GM's own drags don't come through here, so the GM stays free to place anything anywhere.
    const active = state.activeFloorId !== state.currentFloorId
      ? state.floors.find((f) => f.id === state.activeFloorId)
      : null;
    const tokens = active ? (active.tokens || []) : state.tokens;
    const token = tokens.find((t) => t.id === message.id);
    if (token) {
      const commit = () => {
        const snapped = snapNative({ x: message.x, y: message.y });
        const free = nearestFreeCell(snapped, token);
        const dest = resolveMove({ x: message.x, y: message.y }, free);
        token.x = dest.x;
        token.y = dest.y;
      };
      if (active) {
        // Table pinned elsewhere: resolve collision and walls against the active floor, then
        // broadcast (sanitizedState sources the active floor). The GM's canvas is untouched.
        withActiveFloor(active, commit);
        broadcastState();
      } else {
        commit();
        renderAndSync();
      }
    }
  }
  if (message.type === "stair-traverse" && !isPlayer) {
    // A player took a stair with a selection of tokens. They all live on the ACTIVE (table) floor —
    // live state when the GM is viewing that floor, a stored record otherwise. What happens next keys
    // off whether the table is DECOUPLED from the GM's view (pinned OR following initiative), not on
    // whether the two floor pointers happen to coincide. Decoupled: only the token data and the table
    // move while the GM's view stays put (the party walks floors independently of the GM) — pinned
    // walks the table to the target, following points it at the active combatant's floor. Coupled
    // (neither pinned nor following): the GM and party descend together (goToFloor, whose broadcast
    // re-binds the players' selection by id). Branching on active!=current would strand the table for
    // one traverse whenever the GM happened to be co-located on the table's floor.
    const ids = Array.isArray(message.ids) ? message.ids : (message.id != null ? [message.id] : []);
    const targetIdx = state.floors.findIndex((f) => f.id === message.targetFloorId);
    const activeIsLive = state.activeFloorId === state.currentFloorId;
    const sourceFloor = state.floors.find((f) => f.id === state.activeFloorId);
    const sourceTokens = activeIsLive ? state.tokens : ((sourceFloor && sourceFloor.tokens) || []);
    // The riders are every selected token that still lives on the source floor.
    const riders = ids.map((id) => sourceTokens.find((t) => t.id === id)).filter(Boolean);
    if (riders.length && sourceFloor && targetIdx !== -1) {
      const targetFloor = state.floors[targetIdx];
      const targetIsLive = targetFloor.id === state.currentFloorId; // the GM is viewing the target floor
      const paired = (targetFloor.stairs || []).find((s) => s.targetFloorId === sourceFloor.id);
      // Fan the group out around the paired stair (or each token's own cell if there is none), seeding
      // occupancy with the target floor's existing tokens — live state when the GM is viewing it, the
      // stored record otherwise — so nobody lands on an occupant or on another arriving teammate.
      const occupied = [...(targetIsLive ? state.tokens : (targetFloor.tokens || []))];
      const travelers = riders.map((token) => {
        const traveler = JSON.parse(JSON.stringify(token));
        const base = paired ? { x: paired.x, y: paired.y } : { x: traveler.x, y: traveler.y };
        const landing = freeCellOnFloor(snapNative(base), occupied);
        traveler.x = landing.x;
        traveler.y = landing.y;
        occupied.push(traveler); // the next rider nudges away from this one
        return traveler;
      });
      const riderIds = new Set(riders.map((t) => t.id));
      if (!ui.pinTable && !ui.followInitiative) {
        // Coupled (neither pinned nor following): the GM and the party descend together (the
        // long-standing behavior). goToFloor captures this floor (minus the riders), applies the
        // target (with the travelers), and syncs the table to the GM's new floor.
        targetFloor.tokens = [...(targetFloor.tokens || []), ...travelers]; // onto the next floor
        state.tokens = state.tokens.filter((t) => !riderIds.has(t.id)); // off this floor
        goToFloor(targetIdx);
      } else {
        // Decoupled (pinned or following): the GM's view stays put; only the token data and the
        // table move. Pull the riders off the source floor and drop the travelers onto the target —
        // live state when the GM is viewing that floor, the stored record otherwise.
        if (activeIsLive) state.tokens = state.tokens.filter((t) => !riderIds.has(t.id)); // off the live floor
        else sourceFloor.tokens = (sourceFloor.tokens || []).filter((t) => !riderIds.has(t.id)); // off the record
        if (targetIsLive) state.tokens = [...state.tokens, ...travelers]; // target is the GM's live floor
        else targetFloor.tokens = [...(targetFloor.tokens || []), ...travelers]; // target is a record
        if (ui.followInitiative) {
          // Following: the table tracks the active combatant — it lands on the target floor if the
          // active combatant was among the travelers, and stays put otherwise (asset broadcast is
          // handled inside the helper when the table floor actually changes).
          if (!followTableToActiveTurn()) refreshFloorUI();
        } else {
          // Pinned: the table walks with the party to the target floor.
          state.activeFloorId = targetFloor.id;
          refreshFloorUI();
          broadcastAssets();
        }
        render(); // the GM may have just watched the group leave or arrive on their own floor
        broadcastState();
      }
    }
  }
}



function setupStartScreen() {
  const screen = document.getElementById("startScreen");
  if (!screen) return;
  // The player display never shows the opening menu.
  if (isPlayer) {
    screen.remove();
    return;
  }
  const dismiss = () => {
    screen.classList.add("hidden");
    setTimeout(() => screen.remove(), 500);
    window.removeEventListener("keydown", onStartKey);
  };
  const onStartKey = (event) => {
    if (event.key === "Enter" || event.key === "Escape" || event.key === " ") {
      event.preventDefault();
      dismiss();
    }
  };
  document.getElementById("startEnter")?.addEventListener("click", dismiss);
  window.addEventListener("keydown", onStartKey);
}

// Make each GM panel section collapsible: a caret in the title toggles a slide-down
// body. The top action buttons (no heading) stay always visible.
function setupCollapsibleSections() {
  document.querySelectorAll(".gm-panel .control-section").forEach((section) => {
    const title = section.querySelector(":scope > .section-title");
    const heading = title?.querySelector("h2");
    if (!title || !heading) return;
    // Wrap everything after the title in an animatable body (grid-rows 1fr -> 0fr).
    const body = document.createElement("div");
    body.className = "section-body";
    const inner = document.createElement("div");
    inner.className = "section-body-inner";
    while (title.nextSibling) inner.appendChild(title.nextSibling);
    body.appendChild(inner);
    section.appendChild(body);
    // Caret toggle at the start of the title.
    const arrow = document.createElement("button");
    arrow.type = "button";
    arrow.className = "section-toggle";
    arrow.setAttribute("aria-label", "Collapse or expand section");
    arrow.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    title.insertBefore(arrow, title.firstChild);
    section.classList.add("collapsed"); // start collapsed by default; click a title to open
    const toggle = () => section.classList.toggle("collapsed");
    arrow.addEventListener("click", toggle);
    heading.style.cursor = "pointer";
    heading.addEventListener("click", toggle);
  });
}

// The player screen hides the cursor for a clean display, but that also hides the
// fullscreen button. Reveal both whenever the mouse moves, then fade out after a pause.
function setupPlayerCursor() {
  let timer = 0;
  const hide = () => shell.classList.remove("cursor-active");
  window.addEventListener("mousemove", () => {
    shell.classList.add("cursor-active");
    clearTimeout(timer);
    timer = setTimeout(hide, 2500);
  });
}

function setup() {
  shell.dataset.role = isPlayer ? "player" : "gm";
  setupStartScreen();
  if (isPlayer) {
    document.title = "Player Battlemap";
    relay({ type: "player-ready" });
  } else {
    bindControls();
    loadSquareLock();
    loadPaletteThumb();
    if (controls.paletteSize) controls.paletteSize.value = paletteThumbPx;
    loadPalette();
    syncControlsFromState();
    updateSquareLockUI();
    // One-time, idempotent: split any legacy single-record maps into module + session pairs,
    // then give any pre-v6 modules a cell-space declaration.
    migrateMapsToModulesAndSessions()
      .then(() => backfillModuleCellGrids())
      .finally(() => refreshLibraryButtonState());
    updateUndoButtons();
    setupCollapsibleSections();
    updateInitiativeUI();
  }

  // Two transports so the link works whether or not BroadcastChannel delivers between
  // windows (it is unreliable on file://): the BroadcastChannel and a direct
  // window.postMessage to the opener / popup. Messages carry a "mid" so the receiver
  // ignores the duplicate when both transports succeed.
  channel.onmessage = (event) => handleMessage(event.data, null);
  window.addEventListener("message", (event) => handleMessage(event.data, event.source));

  watchCanvasSize();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // Suppress the middle-click autoscroll widget so middle-drag can pan instead.
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", () => {
    if (ui.mode === "aoe" && !isPlayer && tools.aoe.template.visible) {
      tools.aoe.template.visible = false;
      renderAndSyncView();
    }
  });
  // While any drag is in progress, block the browser's native touch scrolling/cancel so a
  // finger drag isn't stolen after the first cell. This is the imperative backstop to the
  // canvas `touch-action: none`, which some touch stacks (e.g. Chromium on Linux with IR
  // touch panels) don't fully honor. Must be non-passive so preventDefault is allowed.
  canvas.addEventListener("touchmove", (event) => {
    if (isDragging) event.preventDefault();
  }, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // Drag-and-drop image files onto the map to place them (GM only).
  if (!isPlayer) {
    canvas.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    });
    canvas.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length || !state.imageData) return;
      event.preventDefault();
      const n = toNativePoint(event);
      files.forEach((file) => addImageFile(file, n.x, n.y));
    });
  }

  if (isPlayer) {
    controls.playerFullscreen?.addEventListener("click", toggleFullscreen);
    setupPlayerCursor();
  }

  resizeCanvas();
  refreshFloorUI();
  render();
  reportPlayerViewport(); // player: announce initial size for the GM's player-frame
}

function bindControls() {
  controls.mapUpload.addEventListener("change", loadMapFile);
  controls.dttUpload.addEventListener("change", loadDttFile);
  controls.splashUpload.addEventListener("change", loadSplashFile);
  controls.splashEnabled.addEventListener("input", () => {
    state.splash.enabled = controls.splashEnabled.checked;
    if (state.splash.enabled) {
      state.blackout = false;
      controls.blackoutEnabled.checked = false;
    }
    renderAndSync();
  });
  controls.blackoutEnabled.addEventListener("input", () => {
    state.blackout = controls.blackoutEnabled.checked;
    if (state.blackout) {
      state.splash.enabled = false;
      controls.splashEnabled.checked = false;
    }
    renderAndSync();
  });
  controls.losEnabled?.addEventListener("input", () => {
    state.los.enabled = controls.losEnabled.checked;
    controls.losOptions?.classList.toggle("hidden", !state.los.enabled);
    renderAndSync();
  });
  controls.loadLibrary.addEventListener("click", openLibrary);
  if (controls.mapUp) controls.mapUp.addEventListener("click", ascend);
  updateMapNavUI();
  controls.saveSession.addEventListener("click", saveSession);
  controls.exportLibrary?.addEventListener("click", exportLibrary);
  controls.importLibrary?.addEventListener("change", importLibrary);
  controls.openPlayer.addEventListener("click", openPlayerWindow);

  const gridBindings = [
    ["gridEnabled", "enabled", "checked"],
    ["gridSnap", "snap", "checked"],
    ["gridSize", "size", "value"],
    ["gridOffsetX", "offsetX", "value"],
    ["gridOffsetY", "offsetY", "value"],
    ["gridColor", "color", "value"],
    ["gridOpacity", "opacity", "value"],
  ];
  gridBindings.forEach(([controlName, stateKey, prop]) => {
    controls[controlName].addEventListener("input", () => {
      state.grid[stateKey] = prop === "checked" ? controls[controlName][prop] : normalizeInput(controls[controlName][prop]);
      renderAndSync();
    });
  });
  controls.gridEnabled.addEventListener("input", updateMeasureCalibrateRow);

  controls.brushSize.addEventListener("input", () => {
    state.fog.toolSize = Number(controls.brushSize.value);
    render();
  });
  controls.fogTint.addEventListener("input", () => {
    state.fog.gmColor = controls.fogTint.value;
    fogBuf.dirty = true;
    render();
  });
  controls.gmFogOpacity.addEventListener("input", () => {
    state.fog.gmOpacity = Number(controls.gmFogOpacity.value);
    render();
  });
  controls.losBrightness?.addEventListener("input", () => {
    state.los.brightness = Number(controls.losBrightness.value);
    renderAndSync();
  });
  controls.resetExplored?.addEventListener("click", () => {
    resetExplored(); // clear any GM-side memory (none today, but keeps behavior local-safe)
    relay({ type: "reset-explored" }); // the player window holds the real explored memory
  });
  controls.mapScale.addEventListener("input", () => {
    const prev = state.map.scale || 1;
    const next = Number(controls.mapScale.value) || 1;
    const r = prev > 0 && next > 0 ? next / prev : 1;
    if (r !== 1) {
      // Keep the cell grid locked to the map as it resizes: scale the cell's world size by the
      // same factor as the image, so obstacles/lights/notes anchored to the grid scale with it
      // instead of detaching. Native px/cell (grid.size / map.scale) stays invariant.
      if (state.grid.size > 0) state.grid.size *= r;
      if (state.measure.cellSize > 0) state.measure.cellSize *= r;
      if (controls.gridSize) controls.gridSize.value = state.grid.size;
    }
    state.map.scale = next;
    renderAndSync();
  });

  controls.paletteAdd?.addEventListener("click", addCurrentToPalette);
  controls.paletteSize?.addEventListener("input", () => setPaletteThumb(Number(controls.paletteSize.value) || 64));
  controls.paletteImport?.addEventListener("change", (e) => {
    importImageFiles(e.target.files);
    e.target.value = "";
  });
  controls.paletteFolder?.addEventListener("change", (e) => {
    importImageFiles(e.target.files);
    e.target.value = "";
  });
  controls.paletteExport?.addEventListener("click", exportPalette);
  controls.paletteJson?.addEventListener("change", (e) => {
    importPaletteJson(e.target.files[0]);
    e.target.value = "";
  });
  controls.paletteDelete?.addEventListener("click", () => {
    if (activePaletteId) deletePaletteEntry(activePaletteId);
  });
  controls.paletteSelectedName?.addEventListener("change", (e) => renameSelectedEntry(e.target.value));

  controls.panMode.addEventListener("click", () => setMode("pan"));
  controls.fogToggle.addEventListener("click", toggleFogRibbon);
  controls.polygonMode.addEventListener("click", () => setMode("polygon"));
  controls.namedPolygonMode.addEventListener("click", () => setMode("namedPolygon"));
  controls.brushMode.addEventListener("click", () => setMode("brush"));
  controls.eraserMode.addEventListener("click", () => setMode("eraser"));
  controls.stampMode?.addEventListener("click", () => setMode("stamp"));
  controls.tokenMode.addEventListener("click", () => setMode("token"));
  controls.aoeMode?.addEventListener("click", () => setMode("aoe"));
  controls.measureMode.addEventListener("click", () => setMode("measure"));
  controls.stairMode?.addEventListener("click", () => setMode("stair"));
  controls.mapLinkMode?.addEventListener("click", () => setMode("mapLink"));
  controls.mapKindSelect?.addEventListener("change", () => {
    state.mapKind = controls.mapKindSelect.value;
    applyMapKindCaps(state.mapKind); // live; persists on next save like any other map edit
  });
  controls.drawMode?.addEventListener("click", () => setMode("draw"));
  controls.lightMode?.addEventListener("click", () => setMode("light"));
  controls.obstacleKind?.addEventListener("change", () => { tools.obstacleKind = controls.obstacleKind.value; });
  controls.showObstacles?.addEventListener("change", () => { tools.showObstacles = controls.showObstacles.checked; render(); });
  controls.lightRadius?.addEventListener("input", () => {
    tools.lightRadius = Number(controls.lightRadius.value) || 1;
    if (controls.lightRadiusVal) controls.lightRadiusVal.textContent = tools.lightRadius;
  });
  controls.lightColor?.addEventListener("input", () => {
    tools.lightColor = controls.lightColor.value || "#ffd9a0";
  });
  controls.tokenLight?.addEventListener("input", () => {
    if (controls.tokenLightVal) controls.tokenLightVal.textContent = Number(controls.tokenLight.value) || 0;
  });
  controls.tokenSelLight?.addEventListener("input", () => {
    if (!sel.token) return;
    sel.token.light = Number(controls.tokenSelLight.value) || 0;
    if (controls.tokenSelLightVal) controls.tokenSelLightVal.textContent = sel.token.light;
    renderAndSync();
  });
  controls.darknessEnabled?.addEventListener("input", () => { state.los.darkness = controls.darknessEnabled.checked; renderAndSync(); });
  controls.losSource?.addEventListener("change", () => { state.los.source = controls.losSource.value; renderAndSync(); });
  controls.castDebug?.addEventListener("change", () => { ui.castDebug = controls.castDebug.checked; render(); });

  // Floor navigation
  controls.floorOverlay?.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "floor-up") { goToFloor(currentFloorIndex() + 1); return; }
    if (act === "floor-down") { goToFloor(currentFloorIndex() - 1); return; }
    if (act === "move-up" || act === "move-down") {
      const li = event.target.closest("[data-idx]");
      if (li) moveFloor(Number(li.dataset.idx), act === "move-up" ? 1 : -1);
      return; // must return before the row-jump below, or reordering would also change floors
    }
    const row = event.target.closest("[data-idx]");
    if (row) goToFloor(Number(row.dataset.idx)); // jump straight to any floor
  });
  controls.addFloorUp?.addEventListener("click", () => addFloor("up"));
  controls.addFloorDown?.addEventListener("click", () => addFloor("down"));
  controls.deleteFloor?.addEventListener("click", deleteCurrentFloor);
  controls.floorName?.addEventListener("change", () => {
    const floor = state.floors[currentFloorIndex()];
    if (floor) {
      floor.name = controls.floorName.value.trim();
      refreshFloorUI();
      broadcastState();
    }
  });
  controls.stairSelFloor?.addEventListener("change", () => {
    if (!sel.stair) return;
    sel.stair.targetFloorId = controls.stairSelFloor.value;
    renderAndSync(); // target changed → the stair's up/down arrow may flip
  });
  controls.stairSelLabel?.addEventListener("input", () => {
    if (!sel.stair) return;
    sel.stair.label = controls.stairSelLabel.value.trim();
    renderAndSync();
  });
  controls.stairSelDelete?.addEventListener("click", () => {
    if (!sel.stair) return;
    pushHistory();
    state.stairs = state.stairs.filter((s) => s !== sel.stair);
    sel.stair = null;
    updateSelectionPanels();
    renderAndSync();
  });
  controls.mapLinkSelTarget?.addEventListener("change", () => {
    if (!sel.mapLink) return;
    sel.mapLink.targetMapId = controls.mapLinkSelTarget.value;
    renderAndSync();
  });
  controls.mapLinkSelLabel?.addEventListener("input", () => {
    if (!sel.mapLink) return;
    sel.mapLink.label = controls.mapLinkSelLabel.value.trim();
    renderAndSync();
  });
  controls.mapLinkSelDelete?.addEventListener("click", () => {
    if (!sel.mapLink) return;
    pushHistory();
    state.mapLinks = state.mapLinks.filter((m) => m !== sel.mapLink);
    sel.mapLink = null;
    updateSelectionPanels();
    renderAndSync();
  });
  controls.aoeSelLabel?.addEventListener("input", () => {
    if (!sel.aoe) return;
    sel.aoe.label = controls.aoeSelLabel.value.trim();
    renderAndSync();
  });
  controls.aoeSelColor?.addEventListener("input", () => {
    if (!sel.aoe) return;
    sel.aoe.color = controls.aoeSelColor.value;
    renderAndSync();
  });
  controls.aoeSelDelete?.addEventListener("click", () => {
    if (!sel.aoe) return;
    pushHistory();
    state.aoes = state.aoes.filter((a) => a !== sel.aoe);
    sel.aoe = null;
    updateSelectionPanels();
    renderAndSync();
  });
  controls.pushToTable?.addEventListener("click", () => {
    // Point the players' table at the floor the GM is currently viewing, and broadcast it.
    state.activeFloorId = state.currentFloorId;
    refreshFloorUI();
    broadcastAssets();
    broadcastState();
  });
  controls.pinTable?.addEventListener("change", () => {
    ui.pinTable = controls.pinTable.checked;
    // Pin and follow are mutually exclusive table drivers — turning pin on clears follow.
    if (ui.pinTable && ui.followInitiative) {
      ui.followInitiative = false;
      if (controls.followInitiative) controls.followInitiative.checked = false;
    }
    // Unpinning re-couples the table to the GM's current view immediately.
    if (!ui.pinTable && state.activeFloorId !== state.currentFloorId) {
      state.activeFloorId = state.currentFloorId;
      broadcastAssets();
      broadcastState();
    }
    refreshFloorUI();
  });
  controls.followInitiative?.addEventListener("change", () => {
    ui.followInitiative = controls.followInitiative.checked;
    if (ui.followInitiative) {
      // Mutually exclusive with pin; turning follow on clears pin and immediately points the
      // table at the active combatant's floor.
      if (ui.pinTable) {
        ui.pinTable = false;
        if (controls.pinTable) controls.pinTable.checked = false;
      }
      if (!followTableToActiveTurn()) refreshFloorUI();
      broadcastState();
    } else {
      // Turning follow off re-couples the table to the GM's current view (like unpinning).
      if (state.activeFloorId !== state.currentFloorId) {
        state.activeFloorId = state.currentFloorId;
        broadcastAssets();
      }
      refreshFloorUI();
      broadcastState();
    }
  });
  controls.roundShape.addEventListener("click", () => setToolShape("round"));
  controls.squareShape.addEventListener("click", () => setToolShape("square"));
  controls.stampRect?.addEventListener("click", () => setStampShape("rectangle"));
  controls.stampSquare?.addEventListener("click", () => setStampShape("square"));
  controls.stampEllipse?.addEventListener("click", () => setStampShape("ellipse"));
  controls.stampCircle?.addEventListener("click", () => setStampShape("circle"));
  controls.stampTriangle?.addEventListener("click", () => setStampShape("triangle"));
  controls.tokenImage?.addEventListener("change", loadTokenImage);
  controls.tokenImageClear?.addEventListener("click", clearTokenImage);
  controls.measureUnit?.addEventListener("change", () => {
    state.measure.unit = controls.measureUnit.value === "metric" ? "metric" : "imperial";
    renderAndSync();
  });
  controls.aoeCircle?.addEventListener("click", () => setAoeShape("circle"));
  controls.aoeSquare?.addEventListener("click", () => setAoeShape("square"));
  controls.aoeCone?.addEventListener("click", () => setAoeShape("cone"));
  controls.aoeColor?.addEventListener("input", () => {
    tools.aoe.color = controls.aoeColor.value;
    render();
  });
  controls.aoeCustomSize?.addEventListener("input", () => {
    const v = parseFloat(controls.aoeCustomSize.value);
    if (v > 0) { tools.aoe.sizeFt = v; updateAoePresets(); render(); }
  });
  controls.aoeAngleSlider?.addEventListener("input", () => {
    tools.aoe.angle = parseFloat(controls.aoeAngleSlider.value) * Math.PI / 180;
    render();
  });
  controls.measureCalibrate?.addEventListener("click", () => armCalibration("measure"));
  controls.gridCalibrate?.addEventListener("click", () => armCalibration("grid"));
  controls.playerFrameToggle?.addEventListener("input", () => {
    ui.showPlayerFrame = controls.playerFrameToggle.checked;
    render();
  });
  controls.playerFrameColor?.addEventListener("input", () => {
    ui.playerFrameColor = controls.playerFrameColor.value;
    render();
  });
  controls.playerFrameOpacity?.addEventListener("input", () => {
    ui.playerFrameOpacity = parseFloat(controls.playerFrameOpacity.value);
    render();
  });
  controls.panelToggle?.addEventListener("click", togglePanelCollapsed);

  // Initiative tracker
  controls.initToggle?.addEventListener("click", toggleInitiative);
  controls.initClose?.addEventListener("click", () => setInitiativeActive(false));
  controls.initPrev?.addEventListener("click", () => stepInitiative(-1));
  controls.initNext?.addEventListener("click", () => stepInitiative(1));
  controls.initReset?.addEventListener("click", resetInitiative);
  controls.initShowPlayers?.addEventListener("input", () => {
    state.initiative.showPlayers = controls.initShowPlayers.checked;
    updateInitiativeUI();
    broadcastState();
  });
  controls.initShowOverlay?.addEventListener("input", () => {
    state.initiative.showOverlay = controls.initShowOverlay.checked;
    updateInitiativeUI();
    broadcastState();
  });
  // Turn arrows / hide button on the bottom-left overlay (GM only).
  controls.initiativeOverlay?.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "ov-next") stepInitiative(1);
    else if (act === "ov-prev") stepInitiative(-1);
    else if (act === "ov-hide") setOverlayVisible(false);
  });
  controls.initAddForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    addCombatant();
  });
  controls.initAddTokens?.addEventListener("click", addTokensToInitiative);
  controls.initImportChars?.addEventListener("click", importMyCharacters);
  controls.initList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    if (event.target.closest("[data-act='remove']")) removeCombatant(id);
    else if (event.target.closest("[data-act='hp-down']")) adjustHp(id, -1);
    else if (event.target.closest("[data-act='hp-up']")) adjustHp(id, 1);
    else if (event.target.closest("[data-act='set-turn']")) setTurnToId(id);
  });
  controls.initList?.addEventListener("change", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    const c = state.initiative.combatants.find((x) => x.id === row.dataset.id);
    if (!c) return;
    if (event.target.matches("[data-field='hp']")) {
      c.hp = event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0);
      if (c.hp != null && (c.maxHp == null || c.hp > c.maxHp)) c.maxHp = c.hp;
    } else if (event.target.matches("[data-field='init']")) {
      c.init = Number(event.target.value) || 0;
      clampInitiativeTurn();
    }
    updateInitiativeUI();
    broadcastState();
  });
  controls.clearFog.addEventListener("click", () => {
    clearFog();
    closeFogRibbon();
  });
  controls.bucketFill?.addEventListener("click", () => {
    fillAllFog();
    closeFogRibbon();
  });
  controls.undo?.addEventListener("click", undo);
  controls.redo?.addEventListener("click", redo);
  controls.fitMap.addEventListener("click", () => fitMap(true));
  controls.fitMapBtn?.addEventListener("click", () => fitMap(true));

  // Close the fog ribbon when clicking anywhere outside it (and outside its toggle).
  document.addEventListener("pointerdown", (event) => {
    if (!isFogRibbonOpen()) return;
    if (event.target.closest("#fogRibbon") || event.target.closest("#fogToggle")) return;
    closeFogRibbon();
  });

  controls.playerMatchDM.addEventListener("input", () => {
    state.playerView.matchDM = controls.playerMatchDM.checked;
    if (state.playerView.matchDM) {
      state.playerView.scale = state.view.scale;
      state.playerView.cx = state.view.cx;
      state.playerView.cy = state.view.cy;
      state.playerView.rotation = state.view.rotation;
    }
    syncPlayerViewControls();
    renderAndSync();
  });
  controls.rotateMapLeft?.addEventListener("click", () => rotateMap(-90));
  controls.rotateMapRight?.addEventListener("click", () => rotateMap(90));
  controls.rotatePlayerLeft?.addEventListener("click", () => rotatePlayerView(-90));
  controls.rotatePlayerRight?.addEventListener("click", () => rotatePlayerView(90));
  controls.playerFit?.addEventListener("click", fitPlayerView);
  controls.stairColor?.addEventListener("input", () => {
    state.stairColor = controls.stairColor.value;
    renderAndSync();
  });
  controls.addImageInput?.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) addImageFile(file, state.view.cx, state.view.cy);
    event.target.value = "";
  });
  controls.addNoteBtn?.addEventListener("click", addNote);
  controls.imageSnap?.addEventListener("input", () => {
    state.grid.snapImages = controls.imageSnap.checked;
  });
  controls.imageShowPlayers?.addEventListener("input", () => {
    if (!sel.image) return;
    sel.image.showPlayers = controls.imageShowPlayers.checked;
    renderAndSync();
  });
  controls.imageSize?.addEventListener("input", () => {
    if (!sel.image) return;
    const aspect = sel.image.w / sel.image.h || 1;
    sel.image.w = Number(controls.imageSize.value);
    sel.image.h = sel.image.w / aspect;
    renderAndSync();
  });
  controls.imageRotation?.addEventListener("input", () => {
    if (!sel.image) return;
    sel.image.rotation = Number(controls.imageRotation.value);
    renderAndSync();
  });
  controls.noteSize?.addEventListener("input", () => {
    if (!sel.note) return;
    sel.note.scale = Number(controls.noteSize.value);
    render(); // notes are GM-only
  });
  controls.tokenSelType?.addEventListener("input", () => {
    if (!sel.token) return;
    sel.token.type = controls.tokenSelType.value;
    renderAndSync();
  });
  controls.tokenSelLabel?.addEventListener("input", () => {
    if (!sel.token) return;
    sel.token.label = controls.tokenSelLabel.value.trim();
    renderAndSync();
  });
  controls.tokenSelColor?.addEventListener("input", () => {
    if (!sel.token) return;
    sel.token.color = controls.tokenSelColor.value;
    renderAndSync();
  });
  controls.tokenSelCells?.addEventListener("input", () => {
    if (!sel.token) return;
    sel.token.cells = Number(controls.tokenSelCells.value) || 1;
    renderAndSync();
  });
  buildConditionGrid();
  buildMapLinkIconGrid(controls.mapLinkIconGrid, (id) => { mapLinkIconChoice = id; });
  buildMapLinkIconGrid(controls.mapLinkSelIconGrid, (id) => {
    if (!sel.mapLink) return;
    pushHistory();
    sel.mapLink.icon = id;
    renderAndSync();
  });
  controls.tokenSelConditions?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-cond]");
    if (!btn || !sel.token) return;
    const id = btn.dataset.cond;
    const set = new Set(sel.token.conditions || []);
    if (set.has(id)) set.delete(id); else set.add(id);
    sel.token.conditions = [...set];
    btn.classList.toggle("active", set.has(id));
    renderAndSync();
  });
  controls.tokenSelExhDown?.addEventListener("click", () => stepExhaustion(-1));
  controls.tokenSelExhUp?.addEventListener("click", () => stepExhaustion(1));
  controls.tokenSelDown?.addEventListener("change", () => {
    if (!sel.token) return;
    sel.token.down = controls.tokenSelDown.checked;
    renderAndSync();
  });
  controls.copyDMView.addEventListener("click", () => snapPlayerViewToGM(true));
  controls.playerZoom.addEventListener("input", () => {
    state.playerView.matchDM = false;
    controls.playerMatchDM.checked = false;
    state.playerView.scale = Number(controls.playerZoom.value);
    captureSquareLock(); // manual zoom re-dials the locked TV square size
    renderAndSyncView();
  });
  controls.lockPlayerSquare?.addEventListener("input", () => {
    setPlayerSquareLock(controls.lockPlayerSquare.checked);
  });
  controls.playerOffsetX.addEventListener("input", () => {
    state.playerView.matchDM = false;
    controls.playerMatchDM.checked = false;
    state.playerView.cx = Number(controls.playerOffsetX.value);
    renderAndSyncView();
  });
  controls.playerOffsetY.addEventListener("input", () => {
    state.playerView.matchDM = false;
    controls.playerMatchDM.checked = false;
    state.playerView.cy = Number(controls.playerOffsetY.value);
    renderAndSyncView();
  });
}

function openPlayerWindow() {
  const url = `${location.pathname}?view=player`;
  peerWindow.ref = window.open(url, "fog-table-player", "popup=yes,width=1280,height=720");
  // The new window announces itself with "player-ready"; we answer with assets + state then.
}

/* ----------------------------- file loading ----------------------------- */

// Install a map from image bytes (a data URL) and a display name: reset the per-floor live
// state the way a fresh map load does, decode the image, capture it into the current floor, and
// fit it to the view. Shared by the file picker (loadMapFile) and the DTT importer (loadDttFile).
// gridOpts, when given as { cellsX, cellsY }, sets the cell grid from the module's known
// cells-across so the overlay lines up with the map's printed grid (step 6a, the DTT "key").
// onReady, when given, runs once the image is decoded and the grid is set, before the floor is
// captured — the seam the DTT importer uses to layer obstacles/lights/notes (6b–6d) onto the map.
function installMap(dataURL, name, gridOpts, onReady) {
  state.imageData = dataURL;
  state.imageName = name;
  state.imageId = uuid();
  state.map.scale = 1;
  state.fog.rooms = [];
  state.fog.strokes = [];
  state.tokens = [];
  state.stairs = [];
  state.mapLinks = [];
  tools.drawingRoom = [];
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  loadImage(state.imageData, () => {
    state.imageWidth = scene.map.naturalWidth;
    state.imageHeight = scene.map.naturalHeight;
    if (gridOpts) applyGridFromCells(gridOpts.cellsX, gridOpts.cellsY);
    if (onReady) onReady(); // DTT import layers obstacles/lights/notes here (6b–6d); grid now set
    fogBuf.dirty = true;
    captureCurrentFloor(); // flush new image into the current floor record
    updatePlayerSliderRanges();
    controls.mapScale.value = state.map.scale;
    refreshFloorUI();
    fitMap(false);
    broadcastAssets();
    renderAndSync();
  });
}

// Set the grid cell size (world px) from a module's cells-across count. On a fresh install
// map.scale is 1, so world px/cell equals native px/cell = imageWidth / cellsX. The two axes
// should agree (square cells); we key off x and warn if they diverge by more than ~1%.
function applyGridFromCells(cellsX, cellsY) {
  if (!cellsX || !state.imageWidth) return;
  const ppcX = state.imageWidth / cellsX;
  if (cellsY) {
    const ppcY = state.imageHeight / cellsY;
    if (Math.abs(ppcX - ppcY) / ppcX > 0.01) {
      console.warn(`DTT grid: px/cell differs by axis (x=${ppcX.toFixed(2)}, y=${ppcY.toFixed(2)}); using x.`);
    }
  }
  state.grid.size = ppcX;
}

function loadMapFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => window.alert("Could not read that image file.");
  reader.onload = () => installMap(reader.result, file.name);
  reader.readAsDataURL(file);
}

/* ----------------------------- DTT module import ----------------------------- */
// Encode raw image bytes as a data URL so the imported map rides the same save/sync rails as a
// file-picked map (state.imageData is a data URL everywhere downstream).
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not encode the map image"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// Named token colors seen in DTT exports map to vwag fill colors; anything unknown falls back to
// the default token amber. (Samples only use "blue", but a small table keeps imports sane.)






// A DTT module import starts a CLEAN board: a single empty floor with nothing carried over from the
// previous map — no extra floors, no leftover obstacles/images/notes, and an empty initiative
// tracker. applyFloor loads the empty floor into live state, clearing every per-floor field in one
// place (so we can't miss one, the way a hand-written reset missed state.images). installMap then
// lays the imported map and geometry onto this fresh floor.
function resetBoardForImport() {
  const floor = makeFloor();
  state.floors = [floor];
  state.activeFloorId = floor.id;
  applyFloor(floor); // sets currentFloorId and clears all live per-floor state to empty
  state.initiative.combatants = [];
  state.initiative.turn = 0;
  state.initiative.round = 1;
  updateInitiativeUI(); // reflect the now-empty tracker (docked panel + player overlay)
}

// Import a DTT module (.zip): read it offline, derive the grid from the DTT key
// (pxPerCell = imageWidth / size.x), install the map at the right scale, and — via installMap's
// onReady seam — import the geometry, lights, tokens, and room notes (6b–6d). Only fog (6e) is
// left, and it's deferred.
async function loadDttFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const entries = await readZip(await file.arrayBuffer());
    const dtt = parseDtt(entries);
    const cellsX = Math.round(dtt.size.x);
    const cellsY = Math.round(dtt.size.y);
    if (!cellsX || !cellsY) throw new Error("module has no grid size");
    const name = file.name.replace(/\.[^.]+$/, ""); // drop the .zip extension for a clean name
    const dataURL = await blobToDataURL(new Blob([dtt.mapBytes], { type: "image/webp" }));
    resetBoardForImport(); // wipe the old board so the module loads onto one fresh floor
    installMap(dataURL, name, { cellsX, cellsY }, () => importDtt(dtt));
  } catch (err) {
    window.alert(`Could not import that DTT module: ${err.message}`);
  } finally {
    event.target.value = ""; // allow re-importing the same file
  }
}

function loadSplashFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = () => window.alert("Could not read that image file.");
  reader.onload = () => {
    state.splash.imageData = reader.result;
    state.splash.imageName = file.name;
    state.splash.enabled = true;
    state.blackout = false;
    controls.splashEnabled.checked = true;
    controls.blackoutEnabled.checked = false;
    loadSplashImage(state.splash.imageData, () => {
      broadcastAssets();
      renderAndSync();
    });
  };
  reader.readAsDataURL(file);
}

/* ----------------------------- library / IndexedDB ----------------------------- */





async function openLibrary() {
  try {
    const sessions = await listSessionRecords();
    renderLibraryList(sessions);
    controls.libraryDialog.showModal();
  } catch (error) {
    window.alert(`Could not open the map library: ${error.message}`);
  }
}

function renderLibraryList(records) {
  controls.savedMapList.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No saved maps yet.";
    controls.savedMapList.appendChild(empty);
    return;
  }

  records
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
    .forEach((record) => {
      const row = document.createElement("div");
      row.className = "saved-map-row";

      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = record.name;
      const meta = document.createElement("span");
      meta.textContent = record.savedAt ? new Date(record.savedAt).toLocaleString() : "Saved map";
      text.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "saved-map-actions";
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = "Load";
      load.addEventListener("click", () => loadLibraryMap(record.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteLibraryMap(record.id, record.name));
      actions.append(load, remove);

      row.append(text, actions);
      controls.savedMapList.appendChild(row);
    });
}

// ─── Map navigation: the containment trail ──────────────────────────────────────
// A "map" here is a module+session pair — one place at one scale (world / settlement / battle).
// descend() pushes onto a breadcrumb trail and keeps the maps you came through warm in memory
// (content.js's snapshot cache), so ascend() pops back instantly with fog/tokens/view exactly as
// you left them. All content enters through content.js's resolver (memory -> IndexedDB ->
// [remote/fallon, chunk 4]), so the online tier slots in later without touching this code.

// Cold load: pull the records through the resolver, merge + hydrate, cache the snapshot, apply.
async function loadMapById(id) {
  const session = await resolveSession(id);
  if (!session) throw new Error("saved game not found");
  const module = await resolveModule(session.moduleId || id);
  if (!module) throw new Error("the map module for this saved game is missing");
  const snapshot = mergeModuleSession(module, session);
  await hydrateFloorImages(snapshot, resolveImage); // floors carry only imageId; pull bytes via the resolver
  cacheSet(id, snapshot);
  applyLoadedSnapshot(snapshot);
}

// Push a merged + hydrated snapshot into live state — shared by the cold load and the warm pop-back.
function applyLoadedSnapshot(snapshot) {
  tools.drawingRoom = [];
  fogBuf.activeStroke = null;
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  loadSnapshot(snapshot);
  syncControlsFromState();
  broadcastAssets();
  renderAndSync();
}

// Go to a map, keeping the one we leave warm. Cold maps load through the resolver; maps already
// visited this session restore from the snapshot cache (instant). Chunk 1's only driver is the
// library picker, so each pick pushes a level — chunk 2's map-links drive descend() from anchors
// on the map itself, and chunk 3 adds sideways jumps.
async function descend(id) {
  if (trailActiveId() === id) return; // already here
  if (trailActiveId()) cacheSet(trailActiveId(), snapshotFromLiveState()); // freeze the map we're leaving
  if (cacheHas(id)) applyLoadedSnapshot(cacheGet(id)); // warm
  else await loadMapById(id); // cold
  trailPush(id);
  updateMapNavUI();
}

// Pop back up to the parent map. Ancestors are never evicted, so the parent is always warm.
function ascend() {
  if (trailDepth() <= 1) return; // at the root — nowhere up to go
  cacheSet(trailActiveId(), snapshotFromLiveState()); // freeze before leaving
  trailPop();
  applyLoadedSnapshot(cacheGet(trailActiveId()));
  updateMapNavUI();
}

// Enable the Up control only when there is a parent to return to.
function updateMapNavUI() {
  if (controls.mapUp) controls.mapUp.disabled = trailDepth() <= 1;
}

async function loadLibraryMap(id) {
  try {
    await descend(id);
    controls.libraryDialog.close();
  } catch (error) {
    window.alert(`Could not load this map: ${error.message}`);
  }
}


async function exportLibrary() {
  try {
    const sessions = await listSessionRecords();
    if (!sessions.length) {
      window.alert("There are no saved maps to export.");
      return;
    }
    const modules = await listModuleRecords();
    // Images live in their own store, so gather the blobs referenced by every module and bundle
    // them with the records — otherwise an exported library would lose its images.
    const imageIds = new Set();
    modules.forEach((module) => (module.floors || []).forEach((floor) => {
      if (floor.imageId) imageIds.add(floor.imageId);
    }));
    const images = [];
    for (const imageId of imageIds) {
      const record = await getImageRecord(imageId);
      if (record) images.push(record);
    }
    const payload = { app: APP_NAME, version: SAVE_FILE_VERSION, exportedAt: new Date().toISOString(), modules, sessions, images };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `battlemap-library-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(`Could not export the library: ${error.message}`);
  }
}


async function refreshLibraryButtonState(existingSessions) {
  if (isPlayer) return;
  try {
    const sessions = existingSessions || (await listSessionRecords());
    const hasMaps = sessions.length > 0;
    controls.loadLibrary.classList.toggle("empty", !hasMaps);
    controls.loadLibrary.disabled = !hasMaps;
    if (controls.exportLibrary) controls.exportLibrary.disabled = !hasMaps;
  } catch {
    controls.loadLibrary.classList.add("empty");
    controls.loadLibrary.disabled = true;
  }
}


/* ----------------------------- module / session split ----------------------------- */




// One-time, idempotent: give pre-v6 modules a cell-space declaration (cellsX/cellsY/pxPerCell).
// The declaration is derived data, so this just makes every module self-describing immediately
// rather than waiting for a re-save. Best-effort per module so it never blocks startup.
async function backfillModuleCellGrids() {
  let modules;
  try {
    modules = await listModuleRecords();
  } catch {
    return;
  }
  if (!Array.isArray(modules) || !modules.length) return;
  for (const module of modules) {
    try {
      if (!module || !module.grid || module.grid.pxPerCell !== undefined) continue;
      const primaryFloor = (module.floors || []).find((f) => f.imageWidth) || (module.floors || [])[0] || null;
      Object.assign(module.grid, deriveCellGrid(module.grid, module.measure || {}, primaryFloor));
      module.version = SAVE_FILE_VERSION;
      await saveModuleRecord(module);
    } catch {
      // Skip this module; never block startup.
    }
  }
}

/* ----------------------------- snapshots / sync ----------------------------- */

// The player rebuilds its line-of-sight/light cast from scratch whenever castVersion bumps. A token
// nudge doesn't move walls or the dozens of static lights an imported module carries, yet the old
// code invalidated the cast on EVERY incoming sync — so the player re-cast every light's shadow
// polygon (O(segments²) each) on every frame the GM touched a token. This signature lets the player
// invalidate only when the wall/light geometry actually changed. It hashes obstacle vertices, door
// open-states (a door toggle changes sight without changing counts), and light positions/radii — a
// few thousand int ops, ~1000x cheaper than a single cast, and it spares ~all of them on a move.
let lastPlayerGeomSig = 0;
function geometrySignature(obstacles, lights) {
  let h = 2166136261; // FNV-1a-ish 32-bit rolling hash
  const mix = (n) => { h = ((h ^ (n | 0)) >>> 0); h = ((h * 16777619) >>> 0); };
  mix(obstacles.length);
  mix(lights.length);
  for (const o of obstacles) {
    mix(o.open ? 1 : 2); // door open-state flips blocksSight without touching geometry
    const pts = o.points || [];
    mix(pts.length);
    for (const p of pts) { mix(p[0]); mix(p[1]); }
  }
  for (const l of lights) { mix(l.x); mix(l.y); mix(l.radius); }
  return h;
}

function loadSnapshot(snapshot) {
  // Shared / global settings.
  Object.assign(state.splash, snapshot.splash || { enabled: false, imageData: "", imageName: "" });
  state.blackout = Boolean(snapshot.blackout);
  if (snapshot.los) Object.assign(state.los, snapshot.los);
  Object.assign(state.grid, snapshot.grid);
  if (state.grid.snap === undefined) state.grid.snap = true;
  if (snapshot.stairColor) state.stairColor = snapshot.stairColor;
  if (snapshot.measure) Object.assign(state.measure, snapshot.measure);
  if (snapshot.mapKind) state.mapKind = snapshot.mapKind;
  state.parentId = snapshot.parentId ?? null;
  if (snapshot.source) state.source = snapshot.source;
  if (snapshot.initiative) {
    state.initiative = { active: false, showPlayers: false, showOverlay: true, round: 1, turn: 0, combatants: [], ...snapshot.initiative };
  }
  if (snapshot.fog) {
    state.fog.toolSize = snapshot.fog.toolSize ?? state.fog.toolSize;
    state.fog.toolShape = snapshot.fog.toolShape ?? state.fog.toolShape;
    state.fog.gmColor = snapshot.fog.gmColor || "#080909";
    state.fog.gmOpacity = snapshot.fog.gmOpacity ?? DEFAULT_GM_FOG_OPACITY;
  }
  const incomingPlayerView = snapshot.playerView || { matchDM: true, ...(snapshot.view || {}) };
  if (isPlayer) applyIncomingPlayerView(incomingPlayerView);
  else Object.assign(state.playerView, incomingPlayerView);

  if (Array.isArray(snapshot.floors) && snapshot.floors.length) {
    // Full load (library / GM): the floor stack is authoritative.
    state.floors = snapshot.floors;
    state.currentFloorId = snapshot.currentFloorId || state.floors[0].id;
    state.activeFloorId = snapshot.activeFloorId || state.currentFloorId;
    applyFloor(state.floors.find((f) => f.id === state.currentFloorId) || state.floors[0]);
  } else {
    // Lightweight sync (player) — only the current floor's live fields are present.
    Object.assign(state.map, snapshot.map || { scale: 1 });
    state.fog.rooms = snapshot.fog?.rooms || [];
    state.fog.strokes = snapshot.fog?.strokes || [];
    // While the player is mid-glide, a stale in-flight snapshot would otherwise snap the walking
    // token back to its pre-move square (the rubber-band bounce) and orphan sel.playerTokens onto the
    // old objects. So during an active glide, hold each gliding token's live local position and
    // re-point the selection at the fresh objects — the player keeps authoritative control of what
    // it's walking until the glide ends, when the drop echo settles the final position normally.
    const gliding = glideKey && sel.playerTokens.length;
    const heldGlide = gliding ? new Map(sel.playerTokens.map((t) => [t.id, { x: t.x, y: t.y }])) : null;
    state.tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens : [];
    if (gliding) {
      sel.playerTokens = sel.playerTokens
        .map((old) => {
          const fresh = state.tokens.find((t) => t.id === old.id);
          if (fresh) { const h = heldGlide.get(old.id); if (h) { fresh.x = h.x; fresh.y = h.y; } }
          return fresh;
        })
        .filter(Boolean);
    }
    state.stairs = Array.isArray(snapshot.stairs) ? snapshot.stairs : [];
    // Obstacles now ride to the player too: the player computes its own line-of-sight locally
    // (cast against these walls), so without them its visibility would be the whole map.
    state.obstacles = Array.isArray(snapshot.obstacles) ? snapshot.obstacles : [];
    state.lights = Array.isArray(snapshot.lights) ? snapshot.lights : [];
    state.aoes = Array.isArray(snapshot.aoes) ? snapshot.aoes : [];
    // Only rebuild the (expensive) cast when walls/lights actually changed — not on the common case
    // of a token nudge, which leaves every static light's cached shadow polygon valid.
    const geomSig = geometrySignature(state.obstacles, state.lights);
    if (geomSig !== lastPlayerGeomSig) {
      invalidateCast();
      lastPlayerGeomSig = geomSig;
    }
    state.images = Array.isArray(snapshot.images) ? snapshot.images : [];
    state.notes = []; // notes are GM-only and never arrive on the player
    Object.assign(state.view, snapshot.view || {});
    state.imageId = snapshot.imageId || state.imageId;
    state.imageData = snapshot.imageData || state.imageData; // keep the image assets delivered separately
    state.imageName = snapshot.imageName || state.imageName;
    if (snapshot.imageWidth) state.imageWidth = snapshot.imageWidth;
    if (snapshot.imageHeight) state.imageHeight = snapshot.imageHeight;
    state.floorPosition = snapshot.floorPosition || 1;
    state.floorCount = snapshot.floorCount || 1;
    state.floorSummary = Array.isArray(snapshot.floorSummary) ? snapshot.floorSummary : [];
  }
  fogBuf.dirty = true;

  // If a sync references a map whose image we never received (assets message missed), ask for it.
  if (isPlayer && state.imageId && !state.imageData) {
    relay({ type: "request-assets" });
  }

  const finish = () => {
    if (snapshot._refit && !isPlayer) fitMap(false);
    if (!isPlayer) {
      updatePlayerSliderRanges();
      syncControlsFromState();
    }
    if (isPlayer && sel.playerTokens.length) {
      // Tokens are fresh objects after a sync; re-point each selected token to its new object by id
      // and drop any that the GM removed, so the rings and arrow-march keep working.
      sel.playerTokens = sel.playerTokens
        .map((sel) => state.tokens.find((t) => t.id === sel.id))
        .filter(Boolean);
    }
    refreshFloorUI();
    updateInitiativeUI();
    render();
    ensureCameraLoop(); // a sync may have moved the party — glide the follow camera to it
  };

  if (state.imageData) {
    loadImage(state.imageData, finish);
  } else {
    scene.map = new Image();
    finish();
  }
  if (state.splash.imageData) {
    loadSplashImage(state.splash.imageData, render);
  }
}

function applyAssets(message) {
  state.imageId = message.imageId;
  state.imageData = message.imageData;
  state.imageName = message.imageName;
  state.splash.imageData = message.splash?.imageData || "";
  state.splash.imageName = message.splash?.imageName || "";
  if (state.imageData) {
    loadImage(state.imageData, () => {
      state.imageWidth = scene.map.naturalWidth;
      state.imageHeight = scene.map.naturalHeight;
      fogBuf.dirty = true;
      render();
    });
  }
  if (state.splash.imageData) loadSplashImage(state.splash.imageData, render);
}



// Toggle floors/initiative chrome to match the active map's kind (chunk 3). The hiding itself is CSS
// (.cap-no-floors / .cap-no-initiative); this just flips the body classes, so it overrides the live
// show/hide logic without touching it. Called on every map load (via syncControlsFromState) and when
// the Map type selector changes.
function applyMapKindCaps(kind) {
  const caps = MAP_KIND_CAPS[kind] || MAP_KIND_CAPS.battle;
  document.body.classList.toggle("cap-no-floors", !caps.floors);
  document.body.classList.toggle("cap-no-initiative", !caps.initiative);
  if (!caps.floors && ui.mode === "stair") setMode("pan"); // stairs only link floors — meaningless here
}

function syncControlsFromState() {
  if (isPlayer) return;
  controls.gridEnabled.checked = state.grid.enabled;
  controls.gridSnap.checked = state.grid.snap;
  if (controls.imageSnap) controls.imageSnap.checked = !!state.grid.snapImages;
  controls.gridSize.value = state.grid.size;
  controls.gridOffsetX.value = state.grid.offsetX;
  controls.gridOffsetY.value = state.grid.offsetY;
  controls.gridColor.value = state.grid.color;
  if (controls.mapKindSelect) controls.mapKindSelect.value = state.mapKind || "battle";
  applyMapKindCaps(state.mapKind || "battle");
  controls.gridOpacity.value = state.grid.opacity;
  controls.splashEnabled.checked = state.splash.enabled;
  controls.blackoutEnabled.checked = state.blackout;
  if (controls.losEnabled) controls.losEnabled.checked = state.los.enabled;
  if (controls.losOptions) controls.losOptions.classList.toggle("hidden", !state.los.enabled);
  if (controls.darknessEnabled) controls.darknessEnabled.checked = Boolean(state.los.darkness);
  if (controls.losSource) controls.losSource.value = state.los.source || "party";
  controls.mapScale.value = state.map.scale;
  controls.brushSize.value = state.fog.toolSize;
  controls.fogTint.value = state.fog.gmColor;
  controls.gmFogOpacity.value = state.fog.gmOpacity;
  if (controls.losBrightness) controls.losBrightness.value = state.los.brightness ?? 0.5;
  setToolShape(state.fog.toolShape);
  setStampShape(state.fog.stampShape || "rectangle");
  setAoeShape(tools.aoe.shape);
  if (controls.aoeColor) controls.aoeColor.value = tools.aoe.color;
  if (controls.aoeCustomSize) controls.aoeCustomSize.value = tools.aoe.sizeFt;
  if (controls.measureUnit) controls.measureUnit.value = state.measure.unit || "imperial";
  if (controls.stairColor) controls.stairColor.value = state.stairColor || "#ffffff";
  updateMeasureCalibrateRow();
  updatePlayerSliderRanges();
  syncPlayerViewControls();
}

function updatePlayerSliderRanges() {
  if (isPlayer) return;
  const w = state.imageWidth || 1000;
  const h = state.imageHeight || 1000;
  controls.playerOffsetX.min = 0;
  controls.playerOffsetX.max = w;
  controls.playerOffsetY.min = 0;
  controls.playerOffsetY.max = h;
}



/* ----------------------------- floor management ----------------------------- */


// Promote a floor record into the active state fields.
function applyFloor(floor) {
  sel.token = sel.image = sel.note = sel.stair = sel.mapLink = sel.aoe = null; // these arrays are about to be replaced
  state.currentFloorId = floor.id;
  state.imageId = floor.imageId || "";
  state.imageData = floor.imageData || "";
  state.imageName = floor.imageName || "";
  state.imageWidth = floor.imageWidth || 0;
  state.imageHeight = floor.imageHeight || 0;
  state.map.scale = floor.mapScale || 1;
  state.fog.rooms = JSON.parse(JSON.stringify(floor.rooms || []));
  state.fog.strokes = JSON.parse(JSON.stringify(floor.strokes || []));
  state.tokens = JSON.parse(JSON.stringify(floor.tokens || []));
  state.stairs = JSON.parse(JSON.stringify(floor.stairs || []));
  state.mapLinks = JSON.parse(JSON.stringify(floor.mapLinks || []));
  state.obstacles = JSON.parse(JSON.stringify(floor.obstacles || []));
  state.lights = JSON.parse(JSON.stringify(floor.lights || []));
  state.aoes = JSON.parse(JSON.stringify(floor.aoes || []));
  invalidateCast();
  state.images = JSON.parse(JSON.stringify(floor.images || []));
  state.notes = JSON.parse(JSON.stringify(floor.notes || []));
  Object.assign(state.view, floor.view || { scale: 1, cx: 0, cy: 0 });
  state.view.rotation = floor.view?.rotation || 0; // default older floors with no rotation
  fogBuf.dirty = true;
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  scene.map = new Image();
  if (state.imageData) {
    loadImage(state.imageData, () => {
      fitMap(false);
      render();
    });
  } else {
    render();
  }
  applyPlayerSquareLock(); // keep the locked TV square size across map/floor changes
}

// Run fn with live state's collision-relevant fields temporarily pointed at `floor` instead of the
// GM's current floor, then restore them. This lets the single collision/clamp implementation
// (snapNative -> nearestFreeCell -> resolveMove, all of which read live state) resolve a player move
// against the floor the players' table is showing while the GM views a different one. Mutations to
// individual tokens persist because state.tokens points at the same array the record holds.
// Synchronous only: handlers never await between swap and restore, so the swap can never leak.
function withActiveFloor(floor, fn) {
  if (!floor.tokens) floor.tokens = [];
  if (!floor.obstacles) floor.obstacles = [];
  const saved = {
    tokens: state.tokens,
    obstacles: state.obstacles,
    imageWidth: state.imageWidth,
    imageHeight: state.imageHeight,
    scale: state.map.scale,
  };
  state.tokens = floor.tokens;
  state.obstacles = floor.obstacles;
  state.imageWidth = floor.imageWidth || 0;
  state.imageHeight = floor.imageHeight || 0;
  state.map.scale = floor.mapScale || 1;
  invalidateCast(); // the wall-segment cache is keyed on castVersion; bump it so it rebuilds for this floor
  try {
    return fn();
  } finally {
    state.tokens = saved.tokens;
    state.obstacles = saved.obstacles;
    state.imageWidth = saved.imageWidth;
    state.imageHeight = saved.imageHeight;
    state.map.scale = saved.scale;
    invalidateCast(); // restore the GM floor's cache
  }
}

function currentFloorIndex() {
  return state.floors.findIndex((f) => f.id === state.currentFloorId);
}

function goToFloor(index) {
  if (index < 0 || index >= state.floors.length) return;
  captureCurrentFloor();
  tools.drawingRoom = [];
  fogBuf.activeStroke = null;
  applyFloor(state.floors[index]);
  // Unless the table is pinned OR following initiative, it follows the GM's view (the long-standing
  // behavior). Pinned or following, the GM roams freely while the table is driven by something else.
  if (!ui.pinTable && !ui.followInitiative) state.activeFloorId = state.currentFloorId;
  updatePlayerSliderRanges();
  syncControlsFromState();
  refreshFloorUI();
  updateSelectionPanels(); // selections were cleared in applyFloor; hide any open Selected-X panel
  broadcastAssets();
  broadcastState();
}

function addFloor(direction) {
  captureCurrentFloor();
  const newFloor = makeFloor();
  const idx = currentFloorIndex();
  if (direction === "up") {
    state.floors.splice(idx + 1, 0, newFloor);
    goToFloor(idx + 1);
  } else {
    state.floors.splice(idx, 0, newFloor);
    goToFloor(idx);
  }
}

function deleteCurrentFloor() {
  if (state.floors.length <= 1) {
    window.alert("You cannot delete the only floor.");
    return;
  }
  if (!window.confirm("Delete this floor? This cannot be undone.")) return;
  const idx = currentFloorIndex();
  state.floors.splice(idx, 1);
  goToFloor(Math.min(idx, state.floors.length - 1));
}

function refreshFloorUI() {
  if (isPlayer) {
    // The player never sees its own floor level (GM-only), but a names-only "rest of party" line
    // shows WHERE split-off teammates are — so nobody at the table forgets the other half exists.
    const badge = controls.playerFloorBadge;
    if (badge) {
      const summary = Array.isArray(state.floorSummary) ? state.floorSummary : [];
      if (summary.length) {
        const parts = summary.map((f) => `${escapeHtml(f.name)} <em>●${f.players}</em>`).join(", ");
        badge.innerHTML = `<span class="pfb-label">Rest of party:</span> ${parts}`;
        badge.hidden = false;
      } else {
        badge.hidden = true;
        badge.textContent = "";
      }
    }
    return;
  }
  const idx = currentFloorIndex();
  const total = state.floors.length;
  const floor = state.floors[idx];
  if (controls.floorName) {
    // Show only the real name; an unnamed floor leaves the field empty with the default label as a
    // greyed placeholder — so it's obvious when a floor is unnamed and a typed name actually sticks.
    controls.floorName.value = floor.name || "";
    controls.floorName.placeholder = `Floor ${idx + 1}`;
  }
  renderFloorOverlay();
  if (controls.pinTable) controls.pinTable.checked = ui.pinTable;
  if (controls.followInitiative) controls.followInitiative.checked = ui.followInitiative;
  // Push is meaningful only when the table is showing a different floor than the GM is viewing.
  if (controls.pushToTable) controls.pushToTable.disabled = state.activeFloorId === state.currentFloorId;
  if (controls.deleteFloor) controls.deleteFloor.disabled = total <= 1;
  if (controls.mapScale) controls.mapScale.value = state.map.scale;
}

// The floor overlay (top-right) mirrors the initiative overlay: a compact box listing every floor,
// highest at the top, the current one highlighted, click a row to jump straight there. The ‹ ›
// header arrows still nudge one floor up/down. Hidden when there's only one floor (nothing to
// navigate) and GM-only — the player window gets this same box later, once parties can split.
// Swap a floor with its neighbour in the stack. currentFloorId/activeFloorId are id-based, so a pure
// array reshuffle doesn't disturb which floor is current or on the players' table, and there's no
// stored floor index anywhere to fix up. Stair up/down arrows are derived from stack order at render
// time, so they flip correctly on their own. dir +1 = up the stack (higher index / toward top).
function moveFloor(i, dir) {
  const f = state.floors;
  const j = i + dir;
  if (i < 0 || i >= f.length || j < 0 || j >= f.length) return;
  [f[i], f[j]] = [f[j], f[i]];
  refreshFloorUI(); // re-render the overlay; current row + end-disabled states recompute
  render();         // stair direction arrows recompute from the new stack order
  broadcastState(); // floors are GM-only, but keep the player's view in lockstep with the contract
}

function renderFloorOverlay() {
  const ov = controls.floorOverlay;
  if (!ov || isPlayer) return;
  const total = state.floors.length;
  const idx = currentFloorIndex();
  ov.hidden = total <= 1;
  if (ov.hidden) return;
  let rows = "";
  const activeIdx = state.floors.findIndex((f) => f.id === state.activeFloorId);
  for (let i = total - 1; i >= 0; i--) {
    const name = escapeHtml(state.floors[i].name || `Floor ${i + 1}`);
    const tokensOn = i === idx ? state.tokens : (state.floors[i].tokens || []);
    const players = tokensOn.filter((t) => t.type === "player").length;
    const badge = players ? `<span class="floor-ov-count"><span class="floor-ov-dot"></span>${players}</span>` : "";
    const onTable = i === activeIdx;
    const tv = onTable ? `<span class="floor-ov-tv" title="Showing on the players' table"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M9 21h6"/><path d="M12 17v4"/></svg></span>` : "";
    const cls = `${i === idx ? "current" : ""}${onTable ? " on-table" : ""}`.trim();
    // Reorder controls: "up" moves the floor toward the top of the stack (higher index), matching
    // the list order (highest floor on top). Disabled at the ends.
    const reorder = `<span class="floor-ov-reorder">`
      + `<button type="button" class="floor-ov-move" data-act="move-up" title="Move floor up" aria-label="Move floor up"${i >= total - 1 ? " disabled" : ""}>▲</button>`
      + `<button type="button" class="floor-ov-move" data-act="move-down" title="Move floor down" aria-label="Move floor down"${i <= 0 ? " disabled" : ""}>▼</button>`
      + `</span>`;
    rows += `<li class="${cls}" data-idx="${i}"><span class="floor-ov-name">${name}</span>${badge}${tv}${reorder}</li>`;
  }
  ov.innerHTML = `<div class="floor-ov-head">
      <button type="button" class="floor-ov-btn" data-act="floor-up" title="Go up one floor" aria-label="Go up"${idx >= total - 1 ? " disabled" : ""}>▲</button>
      <span class="floor-ov-title">Floors</span>
      <button type="button" class="floor-ov-btn" data-act="floor-down" title="Go down one floor" aria-label="Go down"${idx <= 0 ? " disabled" : ""}>▼</button>
    </div><ol class="floor-ov-list">${rows}</ol>`;
}

/* ----------------------------- stairs ----------------------------- */

// Fill a <select> with the floors a stair could lead to — every floor except the current one.
// Shared by the place-stair dialog and the Selected Stair panel so the two never drift. Pass the
// stair's current target to pre-select it when editing.
function populateFloorTargetSelect(select, selectedId) {
  const idx = currentFloorIndex();
  select.replaceChildren();
  state.floors.forEach((floor, i) => {
    if (i === idx) return;
    const opt = document.createElement("option");
    opt.value = floor.id;
    opt.textContent = floor.name || `Floor ${i + 1}`;
    if (floor.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  });
}

function promptStairPlacement(native) {
  if (!controls.stairDialog) return;
  const select = controls.stairFloorSelect;
  if (!select) return;

  populateFloorTargetSelect(select);

  if (!select.options.length) {
    window.alert("Add another floor first before placing stairs.");
    return;
  }

  if (controls.stairLabelInput) controls.stairLabelInput.value = "";
  controls.stairDialog.returnValue = "";
  controls.stairDialog.addEventListener(
    "close",
    () => {
      if (controls.stairDialog.returnValue !== "place") return;
      const targetId = select.value;
      const label = controls.stairLabelInput?.value?.trim() || "";
      pushHistory();
      state.stairs.push({
        id: uuid(),
        x: native.x,
        y: native.y,
        targetFloorId: targetId,
        label,
      });
      renderAndSync();
    },
    { once: true },
  );
  controls.stairDialog.showModal();
}

// Stair marker radius in native pixels — scales with the map as you zoom, just like tokens.
function hitStair(native) {
  // Square hit detection — the marker occupies exactly one grid cell.
  const half = gridCellNative() / 2;
  for (let i = state.stairs.length - 1; i >= 0; i--) {
    const s = state.stairs[i];
    if (Math.abs(native.x - s.x) <= half && Math.abs(native.y - s.y) <= half) {
      return state.stairs[i];
    }
  }
  return null;
}

// ----------------------------- map-links (chunk 2) -----------------------------
// A map-link descends into another saved map. Mirrors the stair authoring loop, but the target is a
// MAP (a saved session's record id) rather than a floor, and clicking one in pan mode descends.

// Fill a <select> with every saved map except the one currently open (no self-links). The library is
// keyed by session record; the stored target is that id verbatim — descend() resolves it.
async function populateMapTargetSelect(select, selectedId) {
  select.replaceChildren();
  let records = [];
  try {
    records = await listSessionRecords();
  } catch {
    records = [];
  }
  const here = trailActiveId();
  records
    .filter((r) => r.id !== here)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name || r.id;
      if (r.id === selectedId) opt.selected = true;
      select.appendChild(opt);
    });
}

// Build a map-link icon picker into `grid`; clicking a glyph calls onPick(iconId) and marks it
// active. Shared by the placement dialog and the Selected Map-Link panel so adding an icon touches
// one spot. Each button carries the same 24x24 glyph the canvas markers use.
function buildMapLinkIconGrid(grid, onPick) {
  if (!grid || grid.childElementCount) return;
  grid.innerHTML = MAP_LINK_ICONS.map((i) =>
    `<button type="button" class="maplink-icon-btn" data-icon="${i.id}" title="${i.label}" aria-label="${i.label}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${i.d}"/></svg></button>`,
  ).join("");
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon]");
    if (!btn) return;
    onPick(btn.dataset.icon);
    setActiveIcon(grid, btn.dataset.icon);
  });
}

// Highlight the matching icon button in a grid (on dialog open / link select).
function setActiveIcon(grid, iconId) {
  if (!grid) return;
  grid.querySelectorAll("[data-icon]").forEach((b) => b.classList.toggle("active", b.dataset.icon === iconId));
}

async function promptMapLinkPlacement(native) {
  if (!controls.mapLinkDialog) return;
  const select = controls.mapLinkTargetSelect;
  if (!select) return;

  await populateMapTargetSelect(select);
  if (!select.options.length) {
    window.alert("Save another map first — a map-link needs a destination map in your library.");
    return;
  }

  mapLinkIconChoice = MAP_LINK_DEFAULT_ICON;
  setActiveIcon(controls.mapLinkIconGrid, mapLinkIconChoice);
  if (controls.mapLinkLabelInput) controls.mapLinkLabelInput.value = "";
  controls.mapLinkDialog.returnValue = "";
  controls.mapLinkDialog.addEventListener(
    "close",
    () => {
      if (controls.mapLinkDialog.returnValue !== "place") return;
      const targetMapId = select.value;
      const label = controls.mapLinkLabelInput?.value?.trim() || "";
      pushHistory();
      state.mapLinks.push({
        id: uuid(),
        x: native.x,
        y: native.y,
        targetMapId,
        icon: mapLinkIconChoice,
        label,
      });
      renderAndSync();
    },
    { once: true },
  );
  controls.mapLinkDialog.showModal();
}

// Square hit detection — the marker occupies exactly one grid cell, like a stair.
function hitMapLink(native) {
  const half = gridCellNative() / 2;
  for (let i = state.mapLinks.length - 1; i >= 0; i--) {
    const m = state.mapLinks[i];
    if (Math.abs(native.x - m.x) <= half && Math.abs(native.y - m.y) <= half) {
      return state.mapLinks[i];
    }
  }
  return null;
}






// Player -> GM live token streaming: coalesce many pointermove events into at most one
// position message per animation frame, so a fast drag never floods the channel.
let groupMoveRaf = 0; // coalesces live group-drag streaming to one relay batch per animation frame

// Stream the live positions of every token in the current group-drag to the GM, coalesced to one
// batch per frame so a fast pointer can't flood the relay. The GM applies each locally (no rebroadcast
// mid-drag) and reconciles authoritatively on the drops.
function streamGroupMove() {
  if (groupMoveRaf || !groupDragOffsets) return;
  groupMoveRaf = requestAnimationFrame(() => {
    groupMoveRaf = 0;
    if (!groupDragOffsets) return;
    for (const o of groupDragOffsets) {
      relay({ type: "token-move", id: o.token.id, x: o.token.x, y: o.token.y });
    }
  });
}



/* ----------------------------- modes / tools ----------------------------- */

const FOG_MODES = ["polygon", "namedPolygon", "brush", "eraser", "stamp"];
// Modes that use the shared fog-options popover (tint/opacity, plus tool-specific rows).
const FOG_TOOL_MODES = ["brush", "eraser", "stamp", "polygon", "namedPolygon"];

function isFogRibbonOpen() {
  return controls.fogRibbon && !controls.fogRibbon.classList.contains("hidden");
}
function openFogRibbon() {
  controls.fogRibbon?.classList.remove("hidden");
}
function closeFogRibbon() {
  controls.fogRibbon?.classList.add("hidden");
}
function toggleFogRibbon() {
  controls.fogRibbon?.classList.toggle("hidden");
}

function setMode(nextMode) {
  if (ui.mode === "aoe" && nextMode !== "aoe") {
    tools.aoe.template.visible = false;
    broadcastView();
  }
  ui.mode = nextMode;
  closeFogRibbon();
  tools.drawingRoom = [];
  tools.drawingObstacle = [];
  fogBuf.stampDraft = null;
  sel.token = null;
  sel.image = sel.note = sel.stair = sel.mapLink = sel.aoe = null;
  updateSelectionPanels();
  canvas.style.cursor = ""; // clear any frame-hover cursor
  controls.fogToggle?.classList.toggle("active", FOG_MODES.includes(nextMode));
  [controls.panMode, controls.polygonMode, controls.namedPolygonMode, controls.brushMode, controls.eraserMode, controls.stampMode, controls.tokenMode, controls.aoeMode, controls.measureMode, controls.stairMode, controls.mapLinkMode, controls.drawMode, controls.lightMode].forEach(
    (button) => button?.classList.remove("active"),
  );
  controls[`${nextMode}Mode`]?.classList.add("active");
  controls.modeHint.textContent = {
    pan: "Drag to move the map. Click a token to select it, then nudge it with the arrow keys. Middle-drag pans in any tool. Wheel to zoom. Alt+click to ping.",
    polygon: "Click corners, Enter to place. Ctrl+Z or Backspace removes the last point.",
    namedPolygon: "Click corners, Enter to place and name (GM-only label). Ctrl+Z removes the last point.",
    brush: "Drag to paint fog. Alt+click to ping.",
    eraser: "Drag over fog to erase brush/bucket fog. Right-click a polygon to clear its area.",
    stamp: "Drag to draw a fog shape. Right-click an area to remove it.",
    token: "Click to drop a token, drag to move it, right-click to remove it.",
    aoe: "Hover to preview. Click to drop a zone; click a zone to rename or delete it. Wheel rotates the cone.",
    measure: "Drag to measure distance across the grid.",
    stair: "Click to place a staircase. Right-click a stair to remove it.",
    mapLink: "Click to place a map-link to another saved map. Click a link in Move/pan mode to travel there. Right-click a link to remove it.",
    draw: "Click corners to draw a wall/obstacle; Enter or double-click to place. Right-click an obstacle to delete. Set a grid first so points land on cells.",
    light: "Click to place a light, right-click a light to remove it. Set its size with the radius slider. Turn on Darkness (under Line of sight) to see lights gate what players can see.",
  }[nextMode] ?? "";

  // Shared fog-options popover: shown for all fog tools, with tool-specific rows toggled.
  const showFogOptions = FOG_TOOL_MODES.includes(nextMode);
  controls.brushOptions.classList.toggle("hidden", !showFogOptions);
  const isBrush = nextMode === "brush" || nextMode === "eraser";
  controls.brushSizeRow?.classList.toggle("hidden", !isBrush);
  controls.brushShapeRow?.classList.toggle("hidden", !isBrush);
  controls.stampShapeRow?.classList.toggle("hidden", nextMode !== "stamp");
  if (controls.fogToolHeading) {
    controls.fogToolHeading.textContent =
      nextMode === "stamp" ? "Fog Shape" : isBrush ? "Fog Brush" : "Fog Area";
  }
  controls.tokenOptions.classList.toggle("hidden", nextMode !== "token");
  controls.tokenPalette?.classList.toggle("hidden", nextMode !== "token");
  controls.drawOptions?.classList.toggle("hidden", nextMode !== "draw");
  controls.lightOptions?.classList.toggle("hidden", nextMode !== "light");
  controls.aoeOptions?.classList.toggle("hidden", nextMode !== "aoe");
  controls.measureOptions?.classList.toggle("hidden", nextMode !== "measure");
  if (nextMode === "measure") updateMeasureCalibrateRow();
  // Switching tools cancels a pending calibration.
  if (tools.calibrating) {
    tools.calibrating = null;
    tools.calibrationDraft = null;
    updateCalibrationUI();
  }
  tools.measureLine = null;
  render();
}

function setStampShape(shape) {
  state.fog.stampShape = shape;
  [
    ["rectangle", controls.stampRect],
    ["square", controls.stampSquare],
    ["ellipse", controls.stampEllipse],
    ["circle", controls.stampCircle],
    ["triangle", controls.stampTriangle],
  ].forEach(([name, button]) => button?.classList.toggle("active", shape === name));
}

function setToolShape(shape) {
  state.fog.toolShape = shape;
  controls.roundShape.classList.toggle("active", shape === "round");
  controls.squareShape.classList.toggle("active", shape === "square");
  render();
}

function clearFog() {
  if (!state.fog.rooms.length && !state.fog.strokes.length) return;
  pushHistory();
  tools.drawingRoom = [];
  state.fog.rooms = [];
  state.fog.strokes = [];
  fogBuf.dirty = true;
  renderAndSync();
}

// Bucket: cover the whole map in fog. Appended as a freeform "fill" op so later erases
// (and right-click area clears) carve through it normally.
function fillAllFog() {
  if (!state.imageData) return;
  pushHistory();
  state.fog.strokes.push({ id: uuid(), kind: "fill" });
  fogBuf.dirty = true;
  renderAndSync();
}

/* ----------------------------- history ----------------------------- */

function snapshotFog() {
  return JSON.stringify({ rooms: state.fog.rooms, strokes: state.fog.strokes, tokens: state.tokens, stairs: state.stairs, images: state.images, notes: state.notes });
}
function pushHistory() {
  undoStack.push(snapshotFog());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function applyFogSnapshot(serialized) {
  const data = JSON.parse(serialized);
  state.fog.rooms = data.rooms || [];
  state.fog.strokes = data.strokes || [];
  state.tokens = data.tokens || [];
  state.stairs = data.stairs || [];
  state.images = data.images || [];
  state.notes = data.notes || [];
  sel.image = sel.note = sel.stair = null;
  fogBuf.dirty = true;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotFog());
  applyFogSnapshot(undoStack.pop());
  tools.drawingRoom = [];
  fogBuf.activeStroke = null;
  updateUndoButtons();
  renderAndSync();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshotFog());
  applyFogSnapshot(redoStack.pop());
  updateUndoButtons();
  renderAndSync();
}
function updateUndoButtons() {
  if (isPlayer) return;
  if (controls.undo) controls.undo.disabled = !undoStack.length;
  if (controls.redo) controls.redo.disabled = !redoStack.length;
}

/* ----------------------------- canvas / view ----------------------------- */

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

// Keep the canvas backing store matched to its CSS box. A ResizeObserver catches the
// responsive panel breakpoint and the player window being resized; the DPR watcher
// catches the window being dragged to a monitor with different pixel density.
function watchCanvasSize() {
  let queued = false;
  const onChange = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      resizeCanvas();
      render();
      reportPlayerViewport(); // keep the GM's player-frame in sync with this display's size
    });
  };
  if (window.ResizeObserver) {
    new ResizeObserver(onChange).observe(canvas);
  } else {
    window.addEventListener("resize", onChange);
  }
  const watchDpr = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        onChange();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();
}








function fitMap(sync) {
  if (!state.imageWidth || !state.imageHeight) return;
  const rect = canvas.getBoundingClientRect();
  state.view.scale = fitScaleFor(rect.width, rect.height, state.view.rotation || 0);
  state.view.cx = state.imageWidth / 2;
  state.view.cy = state.imageHeight / 2;
  if (state.playerView.matchDM && !isPlayer) syncPlayerViewControls();
  render();
  if (sync) broadcastState();
}


// Rotate ONLY the player display. Like the zoom/offset sliders, this gives the player an
// independent view so the rotation is visible while the GM keeps their own orientation.
function rotatePlayerView(deg) {
  state.playerView.matchDM = false;
  if (controls.playerMatchDM) controls.playerMatchDM.checked = false;
  state.playerView.rotation = ((((state.playerView.rotation || 0) + deg) % 360) + 360) % 360;
  syncPlayerViewControls();
  renderAndSync();
}

// Fit-to-screen for the player display, using the size the player reported.
function fitPlayerView() {
  if (!state.imageWidth || !state.imageHeight) return;
  state.playerView.matchDM = false;
  if (controls.playerMatchDM) controls.playerMatchDM.checked = false;
  const rect = canvas.getBoundingClientRect();
  const vw = ui.playerViewport?.w || rect.width;
  const vh = ui.playerViewport?.h || rect.height;
  state.playerView.scale = fitScaleFor(vw, vh, state.playerView.rotation || 0);
  state.playerView.cx = state.imageWidth / 2;
  state.playerView.cy = state.imageHeight / 2;
  captureSquareLock(); // fitting re-dials the locked TV square size
  syncPlayerViewControls();
  renderAndSync();
}

// Begin dragging the red player-view frame. Detaches from "Follow GM" (seeding the player
// view from the GM's framing so it doesn't jump) and records the grab offset so the frame
// tracks the cursor; dragging then pans the player display live.
function startFrameDrag(native, pointerId) {
  if (state.playerView.matchDM) {
    state.playerView.matchDM = false;
    if (controls.playerMatchDM) controls.playerMatchDM.checked = false;
    state.playerView.scale = state.view.scale;
    state.playerView.cx = state.view.cx;
    state.playerView.cy = state.view.cy;
    state.playerView.rotation = state.view.rotation;
  }
  draggingFrame = true;
  dragGrab = { dx: state.playerView.cx - native.x, dy: state.playerView.cy - native.y };
  isDragging = true;
  capturePointer(pointerId);
}

/* ---- Player-square lock (IRL): keep one grid square a fixed physical size on the TV ---- */


// Screen px that one grid square currently occupies on the player display.
function playerSquareScreenPx() {
  const sc = state.playerView.matchDM ? state.view.scale : state.playerView.scale;
  return cellWorldPx() * (state.map.scale || 1) * sc;
}

function persistSquareLock() {
  try {
    localStorage.setItem(SQUARE_LOCK_KEY, JSON.stringify({ on: lockPlayerSquare, px: lockedSquarePx }));
  } catch {}
}

function loadSquareLock() {
  try {
    const v = JSON.parse(localStorage.getItem(SQUARE_LOCK_KEY) || "null");
    if (v && typeof v.px === "number") {
      lockPlayerSquare = !!v.on;
      lockedSquarePx = v.px;
    }
  } catch {}
}

// Re-capture the locked square size from the current player zoom (used when the GM
// deliberately re-dials the TV via the zoom slider or fit while the lock is on).
function captureSquareLock() {
  if (isPlayer || !lockPlayerSquare) return;
  const px = playerSquareScreenPx();
  if (px > 0) {
    lockedSquarePx = px;
    persistSquareLock();
  }
}

// Re-derive the player zoom for THIS map so one grid square equals the locked physical size.
// Different maps have different px-per-square, so the zoom differs per map but the square
// stays the same size on the TV. No-op until this map's grid is calibrated.
function applyPlayerSquareLock() {
  if (isPlayer || !lockPlayerSquare || !lockedSquarePx) return;
  const cell = cellWorldPx();
  const ms = state.map.scale || 1;
  if (cell <= 0) return;
  state.playerView.matchDM = false;
  if (controls.playerMatchDM) controls.playerMatchDM.checked = false;
  state.playerView.scale = lockedSquarePx / (cell * ms);
  syncPlayerViewControls();
  renderAndSync();
}

function setPlayerSquareLock(on) {
  lockPlayerSquare = on;
  if (on) {
    const px = playerSquareScreenPx();
    if (px > 0) lockedSquarePx = px; // capture the current TV calibration as the target
  }
  persistSquareLock();
  updateSquareLockUI();
  if (on) applyPlayerSquareLock();
}

function updateSquareLockUI() {
  if (controls.lockPlayerSquare) controls.lockPlayerSquare.checked = lockPlayerSquare;
}







function toNativePoint(event) {
  return screenToNative(clientToCanvasPoint(event));
}

// Pointer capture keeps a drag tracking even if the cursor leaves the canvas. Guarded
// because a capture can legitimately fail (e.g. the pointer was already released).
function capturePointer(pointerId) {
  try {
    canvas.setPointerCapture(pointerId);
  } catch {}
}

function releasePointer(pointerId) {
  try {
    canvas.releasePointerCapture?.(pointerId);
  } catch {}
}

/* ----------------------------- render ----------------------------- */






/* ----------------------------- fog ----------------------------- */

















// Arm a "drag one square" calibration. The next drag on the map sets either the grid
// size ('grid') or the measurement cell size when the grid overlay is off ('measure').
function armCalibration(purpose) {
  tools.calibrating = tools.calibrating === purpose ? null : purpose;
  tools.calibrationDraft = null;
  updateCalibrationUI();
  controls.modeHint.textContent = tools.calibrating
    ? "Drag a square over one grid cell on the map, then release to set the size."
    : "";
  render();
}

// Both calibrate buttons (Grid and Measure) do the same thing: from the dragged square they
// set the grid cell SIZE, align the grid OFFSET to where the square was drawn, and store the
// measure cell size. Because token snapping and the ruler both read grid size+offset, tokens
// land on the printed cells whether or not the grid overlay is shown.
function finishCalibration() {
  const draft = tools.calibrationDraft;
  const purpose = tools.calibrating;
  tools.calibrationDraft = null;
  tools.calibrating = null;
  updateCalibrationUI();
  if (!draft || !purpose) {
    render();
    return;
  }
  const ms = state.map.scale || 1;
  const wpx = Math.abs(draft.end.x - draft.start.x) * ms;
  const hpx = Math.abs(draft.end.y - draft.start.y) * ms;
  const side = Math.max(wpx, hpx); // tolerate a slightly non-square drag
  if (side < 4) {
    render();
    return;
  }
  const size = Math.max(4, Math.round(side));
  // World-space coords of the square's top-left corner; align a grid line to it.
  const x0w = Math.min(draft.start.x, draft.end.x) * ms;
  const y0w = Math.min(draft.start.y, draft.end.y) * ms;
  const normOffset = (v) => {
    let o = ((v % size) + size) % size; // 0..size
    if (o > size / 2) o -= size; // keep it small: (-size/2, size/2]
    return Math.round(o);
  };
  state.grid.size = size;
  state.grid.offsetX = normOffset(x0w);
  state.grid.offsetY = normOffset(y0w);
  state.measure.cellSize = size; // keeps the ruler correct when the overlay is off
  syncControlsFromState();
  controls.modeHint.textContent = `Calibrated: 1 cell = ${size} px, grid aligned to the square.`;
  renderAndSync();
  applyPlayerSquareLock(); // a fresh calibration re-derives the locked player zoom for this map
}




/* ----------------------------- area of effect ----------------------------- */


function setAoeShape(shape) {
  tools.aoe.shape = shape;
  [
    ["circle", controls.aoeCircle],
    ["square", controls.aoeSquare],
    ["cone", controls.aoeCone],
  ].forEach(([name, btn]) => btn?.classList.toggle("active", shape === name));
  updateAoePresets();
  controls.aoeAngleRow?.classList.toggle("hidden", shape !== "cone");
}

// Rebuild the preset size buttons for the current shape.
function updateAoePresets() {
  const row = controls.aoePresetsRow;
  if (!row) return;
  const presets = AOE_PRESETS[tools.aoe.shape] || [];
  row.innerHTML = "";
  presets.forEach((ft) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${ft} ft`;
    btn.classList.toggle("active", ft === tools.aoe.sizeFt);
    btn.addEventListener("click", () => {
      tools.aoe.sizeFt = ft;
      if (controls.aoeCustomSize) controls.aoeCustomSize.value = ft;
      updateAoePresets();
      render();
    });
    row.appendChild(btn);
  });
}



/* ----------------------------- tokens ----------------------------- */







// Type -> ring color, so player / npc / monster read at a glance on the board.





function hitToken(native, filter) {
  for (let i = state.tokens.length - 1; i >= 0; i--) {
    const token = state.tokens[i];
    if (filter && !filter(token)) continue; // skip tokens the caller isn't allowed to grab
    const r = tokenRadius(token);
    if (tokenIsSquare(token)) {
      if (Math.abs(native.x - token.x) <= r && Math.abs(native.y - token.y) <= r) return token;
    } else if (Math.hypot(native.x - token.x, native.y - token.y) <= r) {
      return token;
    }
  }
  return null;
}




function addToken(native) {
  pushHistory();
  const pos = snapNative(native);
  state.tokens.push({
    id: uuid(),
    x: pos.x,
    y: pos.y,
    cells: Number(controls.tokenCells?.value) || 1,
    color: controls.tokenColor?.value || "#d6a94d",
    label: controls.tokenLabel?.value?.trim() || "",
    type: controls.tokenType?.value || "monster",
    light: Number(controls.tokenLight?.value) || 0,
    image: tokenImageData || "",
    conditions: [],
    exhaustion: 0,
    down: false,
  });
  renderAndSync();
}


const TOKEN_IMAGE_MAX_EDGE = 256; // token art is tiny on screen; cap it to keep saves small

// Downscale a data URL so its longest edge is at most maxEdge, re-encoding to PNG.
// Keeps token art (and therefore the synced/saved state) small regardless of source size.
function downscaleImage(src, maxEdge, callback) {
  const img = new Image();
  img.onload = () => {
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = Math.min(1, maxEdge / longest);
    if (scale >= 1) {
      callback(src); // already small enough
      return;
    }
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    callback(c.toDataURL("image/png"));
  };
  img.onerror = () => callback(src);
  img.src = src;
}

function loadTokenImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => window.alert("Could not read that image file.");
  reader.onload = () => {
    downscaleImage(reader.result, TOKEN_IMAGE_MAX_EDGE, (data) => {
      tokenImageData = data;
      // If a token is selected in Move mode, re-skin it immediately; otherwise this image
      // becomes the default for newly dropped tokens.
      if (sel.token) {
        pushHistory();
        sel.token.image = tokenImageData;
        renderAndSync();
      }
      updateTokenImagePreview();
    });
  };
  reader.readAsDataURL(file);
  event.target.value = ""; // allow re-selecting the same file later
}

function clearTokenImage() {
  tokenImageData = "";
  if (sel.token && sel.token.image) {
    pushHistory();
    sel.token.image = "";
    renderAndSync();
  }
  updateTokenImagePreview();
}

function updateTokenImagePreview() {
  if (!controls.tokenImagePreview) return;
  const has = Boolean(tokenImageData);
  controls.tokenImagePreview.src = has ? tokenImageData : "";
  controls.tokenImagePreview.classList.toggle("hidden", !has);
  controls.tokenImageClear?.classList.toggle("hidden", !has);
}

/* ----------------------------- token palette ----------------------------- */

// Browse-size preference, persisted independently of the palette contents.
function loadPaletteThumb() {
  try {
    const v = Number(localStorage.getItem(PALETTE_THUMB_KEY));
    if (v > 0) paletteThumbPx = v;
  } catch {}
}

function persistPaletteThumb() {
  try {
    localStorage.setItem(PALETTE_THUMB_KEY, String(paletteThumbPx));
  } catch {}
}

// Pull the persisted palette into memory and draw it.
async function loadPalette() {
  try {
    paletteEntries = (await listTokenRecords()) || [];
  } catch {
    paletteEntries = [];
  }
  paletteEntries.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  renderPalette();
}

// Save the current token controls (art + color/type/size/torch) as a reusable template.
async function addCurrentToPalette() {
  const entry = {
    id: uuid(),
    name: (controls.tokenLabel?.value || "").trim() || "Token",
    image: tokenImageData || "",
    color: controls.tokenColor?.value || "#d6a94d",
    type: controls.tokenType?.value || "monster",
    cells: Number(controls.tokenCells?.value) || 1,
    light: Number(controls.tokenLight?.value) || 0,
  };
  try {
    await saveTokenRecord(entry);
  } catch {
    window.alert("Could not save to the palette.");
    return;
  }
  await loadPalette();
}

// Load a palette template into the token controls; the next map click drops a token using it.
function usePaletteEntry(entry) {
  if (controls.tokenColor) controls.tokenColor.value = entry.color || "#d6a94d";
  if (controls.tokenCells) controls.tokenCells.value = entry.cells || 1;
  if (controls.tokenType) controls.tokenType.value = entry.type || "monster";
  if (controls.tokenLabel) controls.tokenLabel.value = entry.name || "";
  if (controls.tokenLight) {
    controls.tokenLight.value = entry.light || 0;
    if (controls.tokenLightVal) controls.tokenLightVal.textContent = entry.light || 0;
  }
  tokenImageData = entry.image || "";
  updateTokenImagePreview();
  activePaletteId = entry.id;
  renderPalette();
}

async function deletePaletteEntry(id) {
  try {
    await deleteTokenRecord(id);
  } catch {}
  if (activePaletteId === id) activePaletteId = null;
  await loadPalette();
}

// Resize the browse thumbnails (the grid columns track the CSS var); persisted across sessions.
function setPaletteThumb(px) {
  paletteThumbPx = Math.max(40, Math.min(140, px || 64));
  persistPaletteThumb();
  if (controls.paletteGrid) controls.paletteGrid.style.setProperty("--palette-thumb", paletteThumbPx + "px");
}

// Build the thumbnail grid: each entry is a swatch (art or color) that loads the template on
// click, a small remove button, and the name.
function renderPalette() {
  const grid = controls.paletteGrid;
  if (!grid) return;
  grid.style.setProperty("--palette-thumb", paletteThumbPx + "px");
  grid.innerHTML = "";
  if (!paletteEntries.length) {
    const empty = document.createElement("p");
    empty.className = "hint palette-empty";
    empty.textContent = "No saved tokens yet. Set up a token, press Add, or import images.";
    grid.appendChild(empty);
    updatePaletteSelectedBar();
    return;
  }
  for (const entry of paletteEntries) {
    const cell = document.createElement("div");
    cell.className = "palette-entry" + (entry.id === activePaletteId ? " active" : "");
    cell.setAttribute("role", "listitem");

    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "palette-thumb";
    swatch.title = entry.name || "Token";
    swatch.setAttribute("aria-label", "Use " + (entry.name || "token"));
    if (entry.image) {
      const img = document.createElement("img");
      img.src = entry.image;
      img.alt = "";
      swatch.appendChild(img);
    } else {
      swatch.style.background = entry.color || "#d6a94d";
    }
    swatch.addEventListener("click", () => usePaletteEntry(entry));

    const name = document.createElement("span");
    name.className = "palette-name";
    name.textContent = entry.name || "Token";

    cell.appendChild(swatch);
    cell.appendChild(name);
    grid.appendChild(cell);
  }
  updatePaletteSelectedBar();
}

// Rename the selected entry; saving re-alphabetizes the grid.
async function renameSelectedEntry(value) {
  const entry = paletteEntries.find((e) => e.id === activePaletteId);
  if (!entry) return;
  const name = (value || "").trim() || "Token";
  if (name === entry.name) return;
  entry.name = name;
  try {
    await saveTokenRecord(entry);
  } catch {
    window.alert("Could not rename that token.");
    return;
  }
  if (controls.tokenLabel) controls.tokenLabel.value = name;
  await loadPalette();
}

// Show the selected-entry bar (name field + delete) for the active template, if any. Skips
// rewriting the name field while it's focused so it doesn't fight the user's typing.
function updatePaletteSelectedBar() {
  const bar = controls.paletteSelected;
  if (!bar) return;
  const entry = paletteEntries.find((e) => e.id === activePaletteId);
  bar.classList.toggle("hidden", !entry);
  if (entry && controls.paletteSelectedName && document.activeElement !== controls.paletteSelectedName) {
    controls.paletteSelectedName.value = entry.name || "";
  }
}

function fileBaseName(name) {
  return (name || "Token").replace(/\.[^.]+$/, "").trim() || "Token";
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsText(file);
  });
}

// Turn image files (a selection or a whole folder) into palette entries, downscaled like token art.
async function importImageFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type && f.type.startsWith("image/"));
  if (!files.length) return;
  for (const file of files) {
    let dataUrl = "";
    try {
      dataUrl = await readFileAsDataURL(file);
    } catch {
      continue;
    }
    const image = await new Promise((res) => downscaleImage(dataUrl, TOKEN_IMAGE_MAX_EDGE, res));
    try {
      await saveTokenRecord({
        id: uuid(),
        name: fileBaseName(file.name),
        image,
        color: "#d6a94d",
        type: "monster",
        cells: 1,
        light: 0,
      });
    } catch {}
  }
  await loadPalette();
}

// Write the whole palette to a JSON file (art embedded) for backup or sharing.
function exportPalette() {
  if (!paletteEntries.length) {
    window.alert("The palette is empty.");
    return;
  }
  const json = JSON.stringify({ version: 1, tokens: paletteEntries }, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vwag-token-palette.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Merge an exported palette JSON into the current one (fresh ids, so it never clobbers existing
// entries). Accepts either a bare array or a { tokens: [...] } wrapper.
async function importPaletteJson(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await readFileAsText(file));
  } catch {
    window.alert("That file isn't a valid palette JSON.");
    return;
  }
  const tokens = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.tokens) ? parsed.tokens : null;
  if (!tokens) {
    window.alert("That file isn't a valid palette JSON.");
    return;
  }
  for (const t of tokens) {
    if (!t || typeof t !== "object") continue;
    try {
      await saveTokenRecord({
        id: uuid(),
        name: (t.name == null ? "Token" : String(t.name)).slice(0, 64) || "Token",
        image: typeof t.image === "string" ? t.image : "",
        color: typeof t.color === "string" ? t.color : "#d6a94d",
        type: typeof t.type === "string" ? t.type : "monster",
        cells: Number(t.cells) || 1,
        light: Number(t.light) || 0,
      });
    } catch {}
  }
  await loadPalette();
}

function nudgeSelectedToken(key) {
  if (!sel.token) return;
  const step = gridCellNative();
  const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  if (!delta) return;
  pushHistory();
  sel.token.x += delta[0] * step;
  sel.token.y += delta[1] * step;
  const snapped = snapNative(sel.token);
  sel.token.x = snapped.x;
  sel.token.y = snapped.y;
  renderAndSync();
}

// --- Player movement clock (1b) -----------------------------------------------------------------
// Hold an arrow and the selected PLAYER token walks at a fixed RATE. The cadence is driven by a
// requestAnimationFrame time-accumulator (the standard fixed-timestep game-loop pattern), so the
// speed is frame-rate independent: PLAYER_MOVE_CELLS_PER_SEC means the same on a 60Hz or 144Hz
// panel. The loop is on-demand — it runs only during a glide, then stops — to spare the solar power
// budget. Each cell-step is collision-resolved like a drag, and the whole march commits to the GM as
// a single token-grab -> token-drop pair, so holding down a hall is one undo step.
//
// Scope note: this is the CADENCE clock only (cells per SECOND, presentation). The per-turn movement
// BUDGET (cells per TURN, i.e. creature speed) is a separate rules layer that will arrive later as
// VWAG creature stats and gate this clock — deliberately NOT built here.

const PLAYER_MOVE_CELLS_PER_SEC = 6; // tunable walk speed (~one D&D 30ft move per 0.75s)
const GLIDE_MAX_CATCHUP_STEPS = 3;   // cap cells stepped per frame after a hitch (anti spiral-of-death)
let glideKey = null;      // arrow key currently driving the glide (null = no glide active)
let glideGrabbed = false; // a token-grab is outstanding, so a token-drop is owed on stop
let glideRaf = 0;         // rAF handle for the on-demand movement loop (0 = stopped)
let glideLastT = 0;       // previous tick timestamp (performance.now) for the dt accumulator
let glideAccum = 0;       // real time (ms) accrued but not yet spent on whole cell-steps

function glideStepIntervalMs() {
  return 1000 / Math.max(1, PLAYER_MOVE_CELLS_PER_SEC);
}

// True if any token OTHER than the moving group holds the cell containing `cellNative`. v1 treats
// every token (any type) as occupying its single center cell — multi-cell footprints come later.
function cellOccupiedByOther(cellNative, groupSet) {
  const c = snapToGrid(cellNative);
  for (const t of state.tokens) {
    if (groupSet.has(t)) continue; // the moving group never blocks itself
    const tc = snapToGrid({ x: t.x, y: t.y });
    if (Math.abs(tc.x - c.x) < 1e-6 && Math.abs(tc.y - c.y) < 1e-6) return true;
  }
  return false;
}

const COLLISION_NUDGE_MAX = 5; // how far (in cells) to search outward for a free cell on a blocked drop

// Nearest cell-center to `desired` not held by any token except `movingToken`, searched outward in
// rings and skipping cells walled off from `desired`. Falls back to `desired` if nothing free is in
// range (better a rare overlap than flinging a token clear across the map).
function nearestFreeCell(desired, movingToken) {
  const group = new Set([movingToken]);
  if (!cellOccupiedByOther(desired, group)) return desired;
  const stepPx = gridCellNative();
  for (let radius = 1; radius <= COLLISION_NUDGE_MAX; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // only the current ring
        const cand = { x: desired.x + dx * stepPx, y: desired.y + dy * stepPx };
        if (cellOccupiedByOther(cand, group)) continue;
        const reached = resolveMove(desired, cand); // don't nudge through a wall
        if (Math.abs(reached.x - cand.x) < 1e-6 && Math.abs(reached.y - cand.y) < 1e-6) return cand;
      }
    }
  }
  return desired;
}

// Nearest cell free of any token in an explicit list — used to place a token onto a floor that
// isn't live yet (a stair traveler landing on the floor it's about to switch to). Occupancy only,
// no wall test: the paired stair always sits on walkable floor, so a wall check buys nothing here.
function freeCellOnFloor(dest, floorTokens) {
  const stepPx = gridCellNative();
  const half = stepPx * 0.5;
  const taken = (c) => floorTokens.some((t) => Math.abs(t.x - c.x) < half && Math.abs(t.y - c.y) < half);
  if (!taken(dest)) return dest;
  for (let radius = 1; radius <= COLLISION_NUDGE_MAX; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // only the current ring
        const cand = { x: dest.x + dx * stepPx, y: dest.y + dy * stepPx };
        if (!taken(cand)) return cand;
      }
    }
  }
  return dest;
}
// cell (no wall stopping it short) AND land on a cell free of any non-group token, or the entire
// formation holds. Because the group moves by one uniform vector it can never collide with itself, so
// occupancy is only tested against non-group tokens. Grabs lazily on the first step that actually
// moves, so holding the party into a wall never creates an empty undo step. Returns true if it moved.
function glideStepOnce() {
  if (!glideKey || !sel.playerTokens.length) return false;
  const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[glideKey];
  if (!delta) return false;
  const step = gridCellNative();
  const group = new Set(sel.playerTokens);
  const planned = [];
  for (const token of sel.playerTokens) {
    const from = { x: token.x, y: token.y };
    const target = { x: from.x + delta[0] * step, y: from.y + delta[1] * step };
    const dest = resolveMove(from, target);
    // A wall stops the step short or slides it: not a clean full cell -> the whole group holds.
    if (Math.abs(dest.x - target.x) > 1e-6 || Math.abs(dest.y - target.y) > 1e-6) return false;
    // A non-group token already holds the destination cell -> the whole group holds.
    if (cellOccupiedByOther(target, group)) return false;
    planned.push({ token, dest: target });
  }
  if (!planned.length) return false;
  if (!glideGrabbed) {
    glideGrabbed = true;
    relay({ type: "token-grab", id: planned[0].token.id }); // one history snapshot for the whole march
  }
  for (const { token, dest } of planned) {
    token.x = dest.x;
    token.y = dest.y;
    // Relay directly per token — glide steps are already rate-limited (6/sec), so per-frame
    // coalescing isn't needed here.
    relay({ type: "token-move", id: token.id, x: dest.x, y: dest.y });
  }
  render(); // immediate local feedback
  ensureCameraLoop(); // glide the follow camera toward the party's new position
  return true;
}

// Begin or redirect a glide. The first step fires instantly so a press responds with no initial
// delay; the rAF loop then maintains the rate.
function startGlide(key) {
  if (!sel.playerTokens.length) return;
  glideKey = key;
  glideStepOnce();
  glideLastT = performance.now();
  glideAccum = 0;
  if (!glideRaf) glideRaf = requestAnimationFrame(glideTick);
}

// rAF loop: bank real elapsed time and spend it on whole cell-steps at the configured rate, frame-
// rate independent. The catch-up cap keeps a resumed/backgrounded tab from teleporting the tokens.
function glideTick(now) {
  glideRaf = 0;
  if (!glideKey || !sel.playerTokens.length) { stopGlide(true); return; }
  const interval = glideStepIntervalMs();
  glideAccum += now - glideLastT;
  glideLastT = now;
  let steps = 0;
  while (glideAccum >= interval && steps < GLIDE_MAX_CATCHUP_STEPS) {
    glideStepOnce(); // a flush-against-wall step is a harmless no-op; the clock keeps ticking
    glideAccum -= interval;
    steps++;
  }
  if (glideAccum > interval) glideAccum = interval; // discard time owed beyond the cap
  glideRaf = requestAnimationFrame(glideTick);
}

// End the glide and commit the final position authoritatively (token-drop = snap + clamp + broadcast),
// pairing the single grab into one undo step. Pass skipCommit=true only when tearing down because the
// selection vanished (nothing to drop).
function stopGlide(skipCommit) {
  if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  glideKey = null;
  glideAccum = 0;
  if (glideGrabbed) {
    glideGrabbed = false;
    if (!skipCommit) {
      for (const token of sel.playerTokens) {
        relay({ type: "token-drop", id: token.id, x: token.x, y: token.y }); // GM snaps, clamps, broadcasts
      }
    }
  }
}

// Player keyup: releasing the arrow that's currently driving the glide ends and commits the march.
// (Releasing a different key — e.g. after switching direction mid-walk — is ignored.)
function onKeyUp(event) {
  if (!isPlayer) return;
  if (event.key === glideKey) {
    event.preventDefault();
    stopGlide(false);
  }
}

// Resolve a finished player marquee into a selection. A box with real area selects every player
// token whose center projects inside it (additive when shift was held at the start); a no-drag tap
// just clears the selection (a shift-tap leaves it alone).
function finishPlayerMarquee() {
  const m = sel.marquee;
  if (!m) return;
  const minX = Math.min(m.x0, m.x1), maxX = Math.max(m.x0, m.x1);
  const minY = Math.min(m.y0, m.y1), maxY = Math.max(m.y0, m.y1);
  const dragged = maxX - minX > 4 || maxY - minY > 4;
  if (!dragged) {
    if (!m.additive) { sel.playerTokens = []; render(); } // empty-space tap clears
    return;
  }
  const inBox = state.tokens.filter((t) => {
    if (t.type !== "player") return false;
    const s = nativeToScreen({ x: t.x, y: t.y });
    return s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
  });
  if (m.additive) {
    const set = new Set(sel.playerTokens);
    inBox.forEach((t) => set.add(t));
    sel.playerTokens = [...set];
  } else {
    sel.playerTokens = inBox;
  }
  render();
}


/* ----------------------------- map images & notes ----------------------------- */









// Add a map image from a (raw) data URL, centered at native (nx, ny). Downscaled to bound size.
function addImageFromDataURL(rawSrc, nx, ny) {
  downscaleImage(rawSrc, IMAGE_MAX_EDGE, (src) => {
    const probe = new Image();
    probe.onload = () => {
      const aspect = probe.naturalWidth / probe.naturalHeight || 1;
      const w = Math.max(40, (state.imageWidth || 1000) * 0.25);
      pushHistory();
      const pos = snapImage({ x: nx, y: ny });
      const im = { id: uuid(), x: pos.x, y: pos.y, w, h: w / aspect, rotation: 0, src, showPlayers: false };
      state.images.push(im);
      sel.token = sel.note = sel.stair = null;
      sel.image = im;
      updateSelectionPanels();
      renderAndSync();
    };
    probe.onerror = () => window.alert("Could not load that image.");
    probe.src = src;
  });
}

function addImageFile(file, nx, ny) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onerror = () => window.alert("Could not read that image file.");
  reader.onload = () => addImageFromDataURL(reader.result, nx, ny);
  reader.readAsDataURL(file);
}

function addNote() {
  const text = window.prompt("Note text (GM only):", "");
  if (text === null) return;
  pushHistory();
  const note = { id: uuid(), x: state.view.cx, y: state.view.cy, text: text || "Note", scale: 1 };
  state.notes.push(note);
  sel.token = sel.image = sel.stair = null;
  sel.note = note;
  updateSelectionPanels();
  render(); // notes are GM-only, no broadcast needed
}

function editNote(note) {
  const text = window.prompt("Edit note (GM only):", note.text || "");
  if (text === null) return;
  pushHistory();
  note.text = text;
  render();
}

// Build the condition toggle grid in the selected-token panel from the CONDITIONS registry — each
// button carries the same 24x24 glyph the canvas markers use and toggles that id on the token.
function buildConditionGrid() {
  const grid = controls.tokenSelConditions;
  if (!grid || grid.childElementCount) return;
  grid.innerHTML = CONDITIONS.map((c) =>
    `<button type="button" class="condition-btn" data-cond="${c.id}" title="${c.label}" aria-label="${c.label}" style="--cond:${c.color}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${c.d}"/></svg></button>`,
  ).join("");
}

function stepExhaustion(delta) {
  if (!sel.token) return;
  sel.token.exhaustion = Math.max(0, Math.min(6, (sel.token.exhaustion || 0) + delta));
  if (controls.tokenSelExhVal) controls.tokenSelExhVal.textContent = sel.token.exhaustion;
  renderAndSync();
}

// Show/populate the View-section panels for the currently selected image or note.
function updateSelectionPanels() {
  if (isPlayer) return;
  if (controls.tokenSelPanel) {
    controls.tokenSelPanel.classList.toggle("hidden", !sel.token);
    if (sel.token) {
      if (controls.tokenSelType) controls.tokenSelType.value = sel.token.type || "monster";
      if (controls.tokenSelLabel) controls.tokenSelLabel.value = sel.token.label || "";
      if (controls.tokenSelColor) controls.tokenSelColor.value = sel.token.color || "#d6a94d";
      if (controls.tokenSelCells) controls.tokenSelCells.value = sel.token.cells || 1;
      if (controls.tokenSelLight) controls.tokenSelLight.value = sel.token.light || 0;
      if (controls.tokenSelLightVal) controls.tokenSelLightVal.textContent = sel.token.light || 0;
      const conds = new Set(sel.token.conditions || []);
      if (controls.tokenSelConditions) {
        controls.tokenSelConditions.querySelectorAll("[data-cond]").forEach((btn) => {
          btn.classList.toggle("active", conds.has(btn.dataset.cond));
        });
      }
      if (controls.tokenSelExhVal) controls.tokenSelExhVal.textContent = sel.token.exhaustion || 0;
      if (controls.tokenSelDown) controls.tokenSelDown.checked = !!sel.token.down;
    }
  }
  if (controls.imageSelPanel) {
    controls.imageSelPanel.classList.toggle("hidden", !sel.image);
    if (sel.image) {
      if (controls.imageShowPlayers) controls.imageShowPlayers.checked = !!sel.image.showPlayers;
      if (controls.imageSize) controls.imageSize.value = Math.round(sel.image.w);
      if (controls.imageRotation) controls.imageRotation.value = Math.round(sel.image.rotation || 0);
    }
  }
  if (controls.noteSelPanel) {
    controls.noteSelPanel.classList.toggle("hidden", !sel.note);
    if (sel.note && controls.noteSize) controls.noteSize.value = sel.note.scale || 1;
  }
  if (controls.stairSelPanel) {
    controls.stairSelPanel.classList.toggle("hidden", !sel.stair);
    if (sel.stair) {
      if (controls.stairSelFloor) populateFloorTargetSelect(controls.stairSelFloor, sel.stair.targetFloorId);
      if (controls.stairSelLabel) controls.stairSelLabel.value = sel.stair.label || "";
    }
  }
  if (controls.mapLinkSelPanel) {
    controls.mapLinkSelPanel.classList.toggle("hidden", !sel.mapLink);
    if (sel.mapLink) {
      if (controls.mapLinkSelTarget) populateMapTargetSelect(controls.mapLinkSelTarget, sel.mapLink.targetMapId);
      if (controls.mapLinkSelLabel) controls.mapLinkSelLabel.value = sel.mapLink.label || "";
      setActiveIcon(controls.mapLinkSelIconGrid, sel.mapLink.icon || MAP_LINK_DEFAULT_ICON);
    }
  }
  if (controls.aoeSelPanel) {
    controls.aoeSelPanel.classList.toggle("hidden", !sel.aoe);
    if (sel.aoe) {
      if (controls.aoeSelLabel) controls.aoeSelLabel.value = sel.aoe.label || "";
      if (controls.aoeSelColor) controls.aoeSelColor.value = sel.aoe.color || "#e2603a";
    }
  }
}

function deleteTokenOrRoom(native) {
  const link = hitMapLink(native);
  if (link) {
    pushHistory();
    state.mapLinks = state.mapLinks.filter((m) => m !== link);
    renderAndSync();
    return true;
  }
  const stair = hitStair(native);
  if (stair) {
    pushHistory();
    state.stairs = state.stairs.filter((s) => s !== stair);
    renderAndSync();
    return true;
  }
  const token = hitToken(native);
  if (token) {
    pushHistory();
    if (token === sel.token) sel.token = null;
    state.tokens = state.tokens.filter((item) => item !== token);
    removeCombatantByToken(token.id);
    renderAndSync();
    return true;
  }
  const image = hitImage(native);
  if (image) {
    pushHistory();
    if (image === sel.image) { sel.image = null; updateSelectionPanels(); }
    state.images = state.images.filter((item) => item !== image);
    renderAndSync();
    return true;
  }
  const room = [...state.fog.rooms].reverse().find((item) => pointInPolygon(native, item.points));
  if (room) {
    pushHistory();
    state.fog.rooms = state.fog.rooms.filter((item) => item !== room);
    // Also clear freeform (brush/bucket) fog inside this area — other polygons are unaffected.
    state.fog.strokes.push({ id: uuid(), kind: "erase", region: "polygon", points: room.points });
    fogBuf.dirty = true;
    renderAndSync();
    return true;
  }
  return false;
}

/* ----------------------------- initiative tracker ----------------------------- */




// Collapse/expand the left control panel. The grid column width animates in CSS; the
// canvas ResizeObserver re-measures the stage as it grows/shrinks.
function togglePanelCollapsed() {
  const collapsed = shell.classList.toggle("panel-collapsed");
  if (controls.panelToggle) {
    const label = collapsed ? "Show controls" : "Hide controls";
    controls.panelToggle.title = label;
    controls.panelToggle.setAttribute("aria-label", collapsed ? "Expand the control panel" : "Collapse the control panel");
  }
}

function toggleInitiative() {
  setInitiativeActive(!state.initiative.active);
}

function setInitiativeActive(on) {
  state.initiative.active = on;
  updateInitiativeUI();
  broadcastState();
  // The docked panel adds/removes a layout column, so the canvas must re-measure.
  requestAnimationFrame(() => {
    resizeCanvas();
    render();
  });
}

function addCombatant() {
  const name = controls.initName.value.trim();
  if (!name) return;
  const init = Number(controls.initRoll.value) || 0;
  const hp = controls.initHp.value === "" ? null : Math.max(0, Number(controls.initHp.value) || 0);
  const type = controls.initType.value || "player";
  state.initiative.combatants.push({ id: uuid(), name, type, init, hp, maxHp: hp });
  controls.initName.value = "";
  controls.initRoll.value = "";
  controls.initHp.value = "";
  controls.initName.focus();
  if (!state.initiative.active) {
    setInitiativeActive(true);
  } else {
    updateInitiativeUI();
    broadcastState();
  }
}

function removeCombatant(id) {
  state.initiative.combatants = state.initiative.combatants.filter((c) => c.id !== id);
  clampInitiativeTurn();
  updateInitiativeUI();
  broadcastState();
}

// Import every board token into the initiative tracker as a linked combatant. Name comes
// from the token label (auto-named by type when blank), type from the token, and a tokenId
// link ties the two so deleting the token later removes its row. Deduped by tokenId, so
// running it again only pulls in tokens that aren't already tracked.
function addTokensToInitiative() {
  const existing = new Set(state.initiative.combatants.map((c) => c.tokenId).filter(Boolean));
  const typeLabel = { player: "Player", npc: "NPC", monster: "Monster" };
  const counts = {};
  state.initiative.combatants.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  let added = 0;
  state.tokens.forEach((token) => {
    if (existing.has(token.id)) return;
    const type = token.type || "monster";
    let name = (token.label || "").trim();
    if (!name) {
      counts[type] = (counts[type] || 0) + 1;
      name = `${typeLabel[type] || "Monster"} ${counts[type]}`;
    }
    state.initiative.combatants.push({ id: uuid(), name, type, init: 0, hp: null, maxHp: null, tokenId: token.id });
    added += 1;
  });
  if (!added) return;
  if (!state.initiative.active) {
    setInitiativeActive(true);
  } else {
    updateInitiativeUI();
    broadcastState();
  }
}

// Pull the active game's characters from VWAG (the Willow bridge) and drop each as a player
// token on the open floor, linked into the initiative tracker with real HP. Mirrors the
// addTokensToInitiative link pattern (combatant.tokenId -> token.id) but seeds HP from the
// character sheet and initiative from the Dex modifier. Deduped by name, so a second run only
// pulls characters not already in the tracker.
//
// Path A: GET /api/session/gm-context already assembles the active game's party (Bearer-authed),
// so no new VWAG endpoint is needed — we read .party and ignore the rest of the payload. The
// party is the active game's roster (identity auth only — per-character ownership is deferred in
// VWAG), which for a solo GM is exactly "my characters."
async function importMyCharacters() {
  if (isPlayer) return;                       // GM view only
  const btn = controls.initImportChars;
  const original = btn ? btn.textContent : "";
  if (!isLoggedIn()) {
    flashImportStatus(btn, "Log in to Victen Worhl first", original);
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }

  let party;
  try {
    const ctx = await apiFetch("/api/session/gm-context");
    party = Array.isArray(ctx?.party) ? ctx.party : [];
  } catch (err) {
    const msg = err.status === 401
      ? "Session expired — log in again"
      : "Can't reach Victen Worhl. Is fallon online?";
    flashImportStatus(btn, msg, original);
    return;
  }

  // Dedupe against names already in the tracker (case-insensitive).
  const have = new Set(
    state.initiative.combatants.map((c) => (c.name || "").trim().toLowerCase()),
  );
  const fresh = party.filter((ch) => {
    const name = (ch.character_name || "").trim();
    return name && !have.has(name.toLowerCase());
  });
  if (!fresh.length) {
    const msg = party.length ? "All characters already imported" : "No active game / characters";
    flashImportStatus(btn, msg, original);
    return;
  }

  // Fan the new tokens around the viewport center so they don't stack on one cell.
  pushHistory();
  const spacing = pxPerCellNative() * 1.5;
  const cx = state.view.cx;
  const cy = state.view.cy;
  fresh.forEach((ch, i) => {
    const name = ch.character_name.trim();
    const pos = snapNative({
      x: cx + (i - (fresh.length - 1) / 2) * spacing,
      y: cy,
    });
    const tokenId = uuid();
    state.tokens.push({
      id: tokenId,
      x: pos.x,
      y: pos.y,
      cells: 1,
      color: "#3fb950",          // player green, matches the type ring
      label: name,
      type: "player",
      light: 0,
      image: "",
      conditions: [],
      exhaustion: 0,
      down: false,
    });
    const dex = Number(ch.dex_score);
    const initMod = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;
    const hp = ch.current_hp == null ? null : Number(ch.current_hp);
    const maxHp = ch.max_hp == null ? null : Number(ch.max_hp);
    state.initiative.combatants.push({
      id: uuid(),
      name,
      type: "player",
      init: initMod,             // Dex-mod default; players overwrite with their real rolls
      hp,
      maxHp,
      tokenId,
    });
  });

  if (!state.initiative.active) {
    setInitiativeActive(true);   // opens the panel, re-measures layout, updates UI, broadcasts
  } else {
    updateInitiativeUI();
    broadcastState();
  }
  renderAndSync();               // paint the new tokens + push one state snapshot to the player

  flashImportStatus(
    btn,
    `Imported ${fresh.length} character${fresh.length === 1 ? "" : "s"}`,
    original,
  );
}

// Briefly show a status message on the import button, then restore its label and re-enable it.
// Keeps the feedback self-contained (no new DOM).
function flashImportStatus(btn, msg, restore) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = msg;
  if (restore !== undefined) {
    setTimeout(() => { btn.textContent = restore; }, 2200);
  }
}

// Remove any combatant linked to this token (used when a token is deleted from the board).
// Manual combatants have no tokenId and are never touched; the link is one-way.
function removeCombatantByToken(tokenId) {
  if (!tokenId) return;
  const before = state.initiative.combatants.length;
  state.initiative.combatants = state.initiative.combatants.filter((c) => c.tokenId !== tokenId);
  if (state.initiative.combatants.length === before) return;
  clampInitiativeTurn();
  updateInitiativeUI();
  broadcastState();
}

function adjustHp(id, delta) {
  const c = state.initiative.combatants.find((x) => x.id === id);
  if (!c || c.hp == null) return;
  const cap = c.maxHp == null ? Infinity : c.maxHp;
  c.hp = Math.max(0, Math.min(cap, (c.hp || 0) + delta));
  updateInitiativeUI();
  broadcastState();
}

function setTurnToId(id) {
  const idx = sortedCombatants().findIndex((c) => c.id === id);
  if (idx >= 0) {
    state.initiative.turn = idx;
    updateInitiativeUI();
    followTableToActiveTurn();
    broadcastState();
  }
}

// Phase C (initiative-follow): which floor a token sits on — live tokens for the GM's current
// floor, records for every other floor. Returns the floor id, or null if the token isn't placed.
function floorIdOfToken(tokenId) {
  if (!tokenId || !state.floors) return null;
  for (const f of state.floors) {
    const toks = f.id === state.currentFloorId ? state.tokens : (f.tokens || []);
    if (toks.some((t) => t.id === tokenId)) return f.id;
  }
  return null;
}

// When "Follow initiative" is on, point the players' table at the floor the active combatant stands
// on. A name-only combatant or a deleted token (no resolvable floor) leaves the table where it is —
// no blank jump, no skipped turn. Ships the new floor's image but leaves the state broadcast to the
// caller (so a turn step still sends one broadcast). Returns true if the table floor changed.
function followTableToActiveTurn() {
  if (!ui.followInitiative) return false;
  const tokenId = activeTurnTokenId();
  if (!tokenId) return false;
  const floorId = floorIdOfToken(tokenId);
  if (!floorId || floorId === state.activeFloorId) return false;
  state.activeFloorId = floorId;
  refreshFloorUI();
  broadcastAssets();
  return true;
}

function stepInitiative(dir) {
  const list = sortedCombatants();
  if (!list.length) return;
  let turn = state.initiative.turn + dir;
  let round = state.initiative.round;
  if (turn >= list.length) {
    turn = 0;
    round += 1;
  } else if (turn < 0) {
    turn = list.length - 1;
    round = Math.max(1, round - 1);
  }
  state.initiative.turn = turn;
  state.initiative.round = round;
  updateInitiativeUI();
  followTableToActiveTurn();
  broadcastState();
}

function resetInitiative() {
  state.initiative.round = 1;
  state.initiative.turn = 0;
  updateInitiativeUI();
  broadcastState();
}




// Hide/show the GM order overlay (the bottom-left box's × button and the GM toggle).
function setOverlayVisible(on) {
  state.initiative.showOverlay = on;
  if (controls.initShowOverlay) controls.initShowOverlay.checked = on;
  updateInitiativeUI();
  broadcastState();
}

/* ----------------------------- ping / measure ----------------------------- */

function triggerPing(native) {
  const color = "#d6a94d";
  addPing(native.x, native.y, color);
  if (!isPlayer) relay({ type: "ping", x: native.x, y: native.y, color });
}







/* ----------------------------- pointer input ----------------------------- */

function onPointerDown(event) {
  ui.lastPointer = { clientX: event.clientX, clientY: event.clientY };

  // Player display: only PLAYER-type tokens can be picked up and moved by touch. NPC and
  // monster tokens are GM-controlled and inert here — a touch on one does nothing. Empty space
  // does nothing either (players never create tokens, edit fog, or move the GM's pieces). A
  // player token sitting under a monster token is still grabbable: the filter skips the monster.
  if (isPlayer) {
    const native = toNativePoint(event);
    const hit = hitToken(native, (t) => t.type === "player");
    if (hit) {
      // On touch/pen, stop the browser from claiming the gesture (scroll/cancel) for itself.
      if (event.pointerType !== "mouse") event.preventDefault();
      if (event.shiftKey) {
        // Shift-click toggles a token in/out of the selection (no drag) — for fixups.
        sel.playerTokens = sel.playerTokens.includes(hit)
          ? sel.playerTokens.filter((t) => t !== hit)
          : [...selectedPlayerTokens, hit];
        render();
      } else {
        // Grab a token to drag. Grabbing a token that's ALREADY in the selection keeps the whole
        // group and drags the formation together; grabbing one that's NOT selected replaces the
        // selection with just it. A no-move tap on a member leaves the group intact (lazy grab).
        if (!sel.playerTokens.includes(hit)) sel.playerTokens = [hit];
        draggingToken = hit; // the anchor the pointer follows
        dragMeasureStart = { x: hit.x, y: hit.y };
        groupDragOffsets = sel.playerTokens.map((t) => ({ token: t, dx: t.x - hit.x, dy: t.y - hit.y }));
        dragGrabbed = false; // grab lazily on the first cell that actually moves
        isDragging = true;
        capturePointer(event.pointerId);
        render();
      }
    } else {
      // Empty space starts a marquee. Shift keeps the current selection and adds the box; without
      // shift the box replaces the selection (and a no-drag tap clears it — handled on pointer-up).
      const p = clientToCanvasPoint(event);
      sel.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: event.shiftKey };
      isDragging = true;
      capturePointer(event.pointerId);
    }
    return;
  }

  // Middle-mouse drags the map in ANY tool, so you can reposition the view without
  // switching tools or accidentally dropping fog.
  if (event.button === 1 && state.imageData) {
    event.preventDefault();
    isDragging = true;
    dragStart = { x: event.clientX, y: event.clientY };
    viewStart = { cx: state.view.cx, cy: state.view.cy };
    capturePointer(event.pointerId);
    return;
  }

  if (event.button === 2) return; // right-click handled by contextmenu

  const native = toNativePoint(event);

  // Calibration drag (set grid size / measure scale by drawing one square) takes priority.
  if (tools.calibrating) {
    tools.calibrationDraft = { start: native, end: native };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    return;
  }

  if (event.altKey) {
    triggerPing(native);
    return;
  }

  if (ui.mode === "stamp") {
    fogBuf.stampDraft = { shape: state.fog.stampShape, start: native, end: native };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    return;
  }

  if (ui.mode === "aoe") {
    // Click an existing zone to select it (Selected AoE panel); click empty map to commit the
    // current hover template as a persistent, labeled zone and select it for naming.
    const hit = hitAoe(native);
    if (hit) {
      sel.aoe = hit;
    } else {
      pushHistory();
      const a = {
        id: uuid(),
        shape: tools.aoe.shape,
        x: native.x,
        y: native.y,
        sizeFt: tools.aoe.sizeFt,
        angle: tools.aoe.angle,
        color: tools.aoe.color,
        label: "",
        effect: null, // reserved: a future animated spell visual binds here (animated-token type)
      };
      state.aoes.push(a);
      sel.aoe = a;
    }
    sel.token = sel.image = sel.note = sel.stair = null;
    updateSelectionPanels();
    renderAndSync();
    return;
  }

  if (ui.mode === "polygon" || ui.mode === "namedPolygon") {
    tools.drawingRoom.push(native);
    render();
    return;
  }

  if (ui.mode === "draw") {
    tools.drawingObstacle.push(native);
    render();
    return;
  }

  if (ui.mode === "light") {
    addLight(native);
    return;
  }

  if (ui.mode === "token") {
    const hit = hitToken(native);
    if (hit) {
      // Clicking a placed token selects it (opens the edit panel) AND starts a drag — so you can
      // rename/recolor/resize a token without leaving Token mode. Empty space still drops a new one.
      pushHistory();
      sel.token = hit;
      sel.image = sel.note = sel.stair = null;
      draggingToken = hit;
      dragMeasureStart = { x: hit.x, y: hit.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
    } else {
      addToken(native);
    }
    return;
  }

  if (ui.mode === "stair") {
    // Click an existing stair to select it (edit target/label/delete in the panel); click empty
    // ground to place a new one. Pan mode keeps its click-a-stair-to-jump shortcut, untouched.
    const existing = hitStair(native);
    if (existing) {
      pushHistory();
      sel.stair = existing;
      sel.token = sel.image = sel.note = null;
      draggingStair = existing;
      dragGrab = { dx: existing.x - native.x, dy: existing.y - native.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
      return;
    }
    if (state.floors.length < 2) {
      window.alert("Add a second floor first.");
      return;
    }
    promptStairPlacement(native);
    return;
  }

  if (ui.mode === "mapLink") {
    // Click an existing link to select it (retarget / change icon / rename / delete in the panel,
    // drag to move); click empty ground to place a new one. Travel is a click in Move/pan mode.
    const existing = hitMapLink(native);
    if (existing) {
      pushHistory();
      sel.mapLink = existing;
      sel.token = sel.image = sel.note = sel.stair = null;
      draggingMapLink = existing;
      dragGrab = { dx: existing.x - native.x, dy: existing.y - native.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
      return;
    }
    promptMapLinkPlacement(native);
    return;
  }

  // In Move mode: click a token to select it (for arrow-key nudging), a note or image to
  // select+drag it, or a stair to jump floors. Clicking empty space clears selection and pans.
  if (ui.mode === "pan") {
    const token = hitToken(native);
    if (token) {
      // Select it (edit panel + arrow-key nudge) AND start a drag, so a click-drag moves the
      // token like every other VTT; a plain click with no movement just selects + snaps in place.
      pushHistory();
      sel.token = token;
      sel.image = sel.note = sel.stair = null;
      draggingToken = token;
      dragMeasureStart = { x: token.x, y: token.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
      return;
    }
    const note = hitNote(clientToCanvasPoint(event));
    if (note) {
      pushHistory();
      sel.note = note;
      sel.token = sel.image = sel.stair = null;
      draggingNote = note;
      dragGrab = { dx: note.x - native.x, dy: note.y - native.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
      return;
    }
    const image = hitImage(native);
    if (image) {
      pushHistory();
      sel.image = image;
      sel.token = sel.note = sel.stair = null;
      draggingImage = image;
      dragGrab = { dx: image.x - native.x, dy: image.y - native.y };
      isDragging = true;
      capturePointer(event.pointerId);
      updateSelectionPanels();
      render();
      return;
    }
    const stair = hitStair(native);
    if (stair) {
      const idx = state.floors.findIndex((f) => f.id === stair.targetFloorId);
      if (idx !== -1) goToFloor(idx);
      return;
    }
    const link = hitMapLink(native);
    if (link && link.targetMapId) {
      descend(link.targetMapId); // push the trail and load the child map (chunk 1 machinery)
      return;
    }
    // Click a door to toggle it open/closed (GM only). Open doors pass sight, light, and
    // movement; the change syncs to players, whose line-of-sight then reveals through the opening.
    const door = hitObstacle(native);
    if (door && door.kind === "door" && door.openable !== false) {
      pushHistory();
      door.open = !door.open;
      invalidateCast();
      renderAndSync();
      return;
    }
    // Dragging the red player-view frame pans the player display in real time.
    const frame = playerFrameCorners();
    if (frame && pointInPolygon(clientToCanvasPoint(event), frame)) {
      startFrameDrag(native, event.pointerId);
      return;
    }
    if (sel.token || sel.image || sel.note || sel.stair) {
      sel.token = sel.image = sel.note = sel.stair = null;
      updateSelectionPanels();
      render();
    }
  }

  if (ui.mode === "measure") {
    tools.measureLine = { start: native, end: native };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    relay({ type: "measure", line: tools.measureLine });
    return;
  }

  if (ui.mode === "brush" || ui.mode === "eraser") {
    pushHistory();
    fogBuf.activeStroke = {
      id: uuid(),
      kind: ui.mode === "eraser" ? "erase" : "paint",
      shape: state.fog.toolShape,
      size: state.fog.toolSize,
      points: [native],
    };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    return;
  }

  // pan
  if (!state.imageData) return;
  isDragging = true;
  dragStart = { x: event.clientX, y: event.clientY };
  viewStart = { cx: state.view.cx, cy: state.view.cy };
  capturePointer(event.pointerId);
}

function onPointerMove(event) {
  ui.lastPointer = { clientX: event.clientX, clientY: event.clientY };

  // Player display: drag the selected formation locally for feedback, or stretch a marquee.
  if (isPlayer) {
    if (draggingToken && groupDragOffsets) {
      const anchorTarget = toNativePoint(event);
      const moved = [];
      for (const o of groupDragOffsets) {
        const target = { x: anchorTarget.x + o.dx, y: anchorTarget.y + o.dy };
        const dest = resolveMove({ x: o.token.x, y: o.token.y }, target);
        if (Math.abs(dest.x - o.token.x) < 1e-6 && Math.abs(dest.y - o.token.y) < 1e-6) continue;
        o.token.x = dest.x;
        o.token.y = dest.y;
        moved.push(o.token);
      }
      if (moved.length) {
        if (dragMeasureStart) tools.dragMeasureLine = { start: dragMeasureStart, end: { x: draggingToken.x, y: draggingToken.y } };
        if (!dragGrabbed) {
          dragGrabbed = true;
          relay({ type: "token-grab", id: draggingToken.id }); // one history snapshot for the drag
        }
        render();
        streamGroupMove();
        ensureCameraLoop(); // glide the follow camera as the party is dragged
      }
    } else if (sel.marquee) {
      const p = clientToCanvasPoint(event);
      sel.marquee.x1 = p.x;
      sel.marquee.y1 = p.y;
      render();
    }
    return;
  }

  if (!isDragging) {
    if (["brush", "eraser"].includes(ui.mode)) render(); // live tool preview
    if (ui.mode === "aoe" && state.imageData) {
      const native = toNativePoint(event);
      tools.aoe.template.x = native.x;
      tools.aoe.template.y = native.y;
      tools.aoe.template.visible = true;
      renderAndSyncView();
    }
    // Hint that the player-view frame can be dragged.
    if (ui.mode === "pan" && state.imageData) {
      const frame = playerFrameCorners();
      canvas.style.cursor = frame && pointInPolygon(clientToCanvasPoint(event), frame) ? "move" : "";
    }
    return;
  }

  if (tools.calibrationDraft) {
    tools.calibrationDraft.end = toNativePoint(event);
    render();
    return;
  }

  if (fogBuf.stampDraft) {
    fogBuf.stampDraft.end = toNativePoint(event);
    render();
    return;
  }

  if (fogBuf.activeStroke) {
    const point = toNativePoint(event);
    const previous = fogBuf.activeStroke.points[fogBuf.activeStroke.points.length - 1];
    const spacing = Math.max(2, fogBuf.activeStroke.size / 4);
    addInterpolatedStrokePoints(fogBuf.activeStroke, previous, point, spacing);
    render();
    return;
  }

  if (draggingFrame) {
    const native = toNativePoint(event);
    state.playerView.cx = native.x + dragGrab.dx;
    state.playerView.cy = native.y + dragGrab.dy;
    syncPlayerViewControls();
    renderAndSyncView(); // pans the player display live
    return;
  }

  if (draggingToken) {
    const native = toNativePoint(event);
    draggingToken.x = native.x;
    draggingToken.y = native.y;
    if (dragMeasureStart) tools.dragMeasureLine = { start: dragMeasureStart, end: { x: draggingToken.x, y: draggingToken.y } };
    render(); // local only; players get the token's final position on drop
    return;
  }

  if (draggingImage) {
    const native = toNativePoint(event);
    draggingImage.x = native.x + dragGrab.dx;
    draggingImage.y = native.y + dragGrab.dy;
    render();
    return;
  }

  if (draggingNote) {
    const native = toNativePoint(event);
    draggingNote.x = native.x + dragGrab.dx;
    draggingNote.y = native.y + dragGrab.dy;
    render();
    return;
  }

  if (draggingStair) {
    const native = toNativePoint(event);
    draggingStair.x = native.x + dragGrab.dx;
    draggingStair.y = native.y + dragGrab.dy;
    render(); // local only; stairs are GM-only
    return;
  }

  if (draggingMapLink) {
    const native = toNativePoint(event);
    draggingMapLink.x = native.x + dragGrab.dx;
    draggingMapLink.y = native.y + dragGrab.dy;
    render(); // local only; map-links are GM-only
    return;
  }

  if (tools.measureLine) {
    tools.measureLine.end = toNativePoint(event);
    render();
    relay({ type: "measure", line: tools.measureLine });
    return;
  }

  // pan — un-rotate the screen-space drag delta into native coords
  const t = viewTransform();
  const ddx = event.clientX - dragStart.x;
  const ddy = event.clientY - dragStart.y;
  const cos = Math.cos(-t.rot);
  const sin = Math.sin(-t.rot);
  const s = t.k * t.ms;
  state.view.cx = viewStart.cx - (ddx * cos - ddy * sin) / s;
  state.view.cy = viewStart.cy - (ddx * sin + ddy * cos) / s;
  if (state.playerView.matchDM) {
    state.playerView.cx = state.view.cx;
    state.playerView.cy = state.view.cy;
    syncPlayerViewControls();
  }
  renderAndSyncView();
}

function onPointerUp(event) {
  if (isPlayer) {
    if (draggingToken && groupDragOffsets) {
      if (groupMoveRaf) { cancelAnimationFrame(groupMoveRaf); groupMoveRaf = 0; } // drop any queued stream
      if (dragGrabbed) {
        // Commit each token's final raw position; the GM snaps + clamps + broadcasts to reconcile
        // every display. The single grab + these drops are one undo step.
        for (const o of groupDragOffsets) {
          relay({ type: "token-drop", id: o.token.id, x: o.token.x, y: o.token.y });
        }
      }
      draggingToken = null;
      groupDragOffsets = null;
      dragGrabbed = false;
      tools.dragMeasureLine = null;
      dragMeasureStart = null;
    } else if (sel.marquee) {
      finishPlayerMarquee();
      sel.marquee = null;
    }
    isDragging = false;
    return;
  }

  if (tools.calibrationDraft) {
    finishCalibration();
    releasePointer(event.pointerId);
    isDragging = false;
    return;
  }

  if (fogBuf.stampDraft) {
    const points = stampPolygon(fogBuf.stampDraft.shape, fogBuf.stampDraft.start, fogBuf.stampDraft.end);
    fogBuf.stampDraft = null;
    if (points) {
      pushHistory();
      state.fog.rooms.push({ id: uuid(), points, revealed: false, name: "" });
      fogBuf.dirty = true;
      renderAndSync();
    } else {
      render();
    }
  }

  if (fogBuf.activeStroke) {
    state.fog.strokes.push(fogBuf.activeStroke);
    fogBuf.activeStroke = null;
    fogBuf.dirty = true; // re-bake the freeform layer so the committed stroke composites correctly
    renderAndSync();
  }

  if (draggingToken) {
    const snapped = snapNative({ x: draggingToken.x, y: draggingToken.y });
    draggingToken.x = snapped.x;
    draggingToken.y = snapped.y;
    draggingToken = null;
    tools.dragMeasureLine = null;
    dragMeasureStart = null;
    renderAndSync();
  }

  if (draggingImage) {
    const snapped = snapImage({ x: draggingImage.x, y: draggingImage.y });
    draggingImage.x = snapped.x;
    draggingImage.y = snapped.y;
    draggingImage = null;
    renderAndSync(); // sync the moved image to players
  }

  if (draggingNote) {
    draggingNote = null;
    render(); // notes are GM-only
  }

  if (draggingStair) {
    draggingStair = null;
    renderAndSync(); // GM-only, but matches the place/delete commit path
  }

  if (draggingMapLink) {
    draggingMapLink = null;
    renderAndSync(); // GM-only, matches the place/delete commit path
  }

  if (draggingFrame) {
    draggingFrame = false;
    renderAndSync(); // persist the player view position
  }

  if (tools.measureLine && ui.mode === "measure") {
    tools.measureLine = null;
    render();
    relay({ type: "measure", line: null });
  }

  if (isDragging) {
    releasePointer(event.pointerId);
    broadcastState();
  }
  isDragging = false;
}

function onWheel(event) {
  if (!state.imageData) return;

  // The player display is view-only; the GM drives its framing.
  if (isPlayer) return;

  // Rotate cone when in AoE mode (don't zoom)
  if (ui.mode === "aoe" && tools.aoe.shape === "cone") {
    event.preventDefault();
    tools.aoe.angle += event.deltaY < 0 ? -0.1 : 0.1;
    if (controls.aoeAngleSlider) {
      const deg = ((tools.aoe.angle * 180 / Math.PI) % 360 + 360) % 360;
      controls.aoeAngleSlider.value = Math.round(deg);
    }
    renderAndSyncView();
    return;
  }

  event.preventDefault();
  const p = clientToCanvasPoint(event);
  const before = screenToNative(p);
  const zoom = event.deltaY < 0 ? 1.08 : 0.92;
  state.view.scale = Math.min(16, Math.max(0.02, state.view.scale * zoom));
  // Recompute the center so the point under the cursor stays put (rotation-aware).
  const t = viewTransform();
  const s = t.k * t.ms;
  const ox = p.x - t.centerX;
  const oy = p.y - t.centerY;
  const cos = Math.cos(-t.rot);
  const sin = Math.sin(-t.rot);
  state.view.cx = before.x - (ox * cos - oy * sin) / s;
  state.view.cy = before.y - (ox * sin + oy * cos) / s;
  if (state.playerView.matchDM) {
    state.playerView.scale = state.view.scale;
    state.playerView.cx = state.view.cx;
    state.playerView.cy = state.view.cy;
    syncPlayerViewControls();
  }
  renderAndSyncView();
}

function onDoubleClick(event) {
  if (isPlayer) {
    toggleFullscreen();
    return;
  }
  const note = hitNote(clientToCanvasPoint(event));
  if (note) {
    editNote(note);
    return;
  }
  if (ui.mode === "polygon" || ui.mode === "namedPolygon") finishRoom();
  if (ui.mode === "draw") finishObstacle();
}

function onContextMenu(event) {
  if (isPlayer) return;
  event.preventDefault();
  const note = hitNote(clientToCanvasPoint(event));
  if (note) {
    pushHistory();
    if (note === sel.note) { sel.note = null; updateSelectionPanels(); }
    state.notes = state.notes.filter((n) => n !== note);
    render();
    return;
  }
  if (ui.mode === "draw") {
    const ob = hitObstacle(toNativePoint(event));
    if (ob) {
      pushHistory();
      state.obstacles = state.obstacles.filter((o) => o !== ob);
      invalidateCast();
      renderAndSync();
    }
    return;
  }
  if (ui.mode === "light") {
    const lt = hitLight(toNativePoint(event));
    if (lt) {
      pushHistory();
      state.lights = state.lights.filter((l) => l !== lt);
      invalidateCast();
      renderAndSync();
    }
    return;
  }
  if (ui.mode === "aoe") {
    const a = hitAoe(toNativePoint(event));
    if (a) {
      pushHistory();
      if (a === sel.aoe) { sel.aoe = null; updateSelectionPanels(); }
      state.aoes = state.aoes.filter((x) => x !== a);
      renderAndSync();
    }
    return;
  }
  deleteTokenOrRoom(toNativePoint(event));
}

function onKeyDown(event) {
  if (isPlayer) {
    if (event.key === "f" || event.key === "F") {
      toggleFullscreen();
      return;
    }
    if (event.key === "c" || event.key === "C") {
      playerCam.follow = !playerCam.follow; // toggle the party follow-camera
      if (playerCam.follow) ensureCameraLoop(); else stopCameraLoop();
      render();
      return;
    }
    if (event.key === "z" || event.key === "Z") {
      playerCam.fitZoom = !playerCam.fitZoom; // toggle fit-to-party zoom
      if (playerCam.fitZoom) playerCam.follow = true; // fitting implies following the party
      if (playerCam.follow) ensureCameraLoop(); else stopCameraLoop();
      render();
      return;
    }
    // 's' takes the stairs: if any selected token stands on a stair, ask the GM (who owns the floor
    // stack) to carry the WHOLE selection to the linked floor. The rider on the stair sets the
    // destination; everyone selected rides along and fans out around the paired stair on arrival.
    if (event.key === "s" || event.key === "S") {
      const rider = sel.playerTokens
        .map((t) => ({ token: t, stair: hitStair({ x: t.x, y: t.y }) }))
        .find((o) => o.stair && o.stair.targetFloorId);
      if (rider) {
        const ids = sel.playerTokens.map((t) => t.id); // the whole selection rides together
        relay({ type: "stair-traverse", ids, targetFloorId: rider.stair.targetFloorId });
      }
      return;
    }
    // Arrow keys walk the selected player token(s). First press steps instantly; holding marches at
    // PLAYER_MOVE_CELLS_PER_SEC via the rAF movement clock. One token-grab + one drop-per-token per march.
    if (sel.playerTokens.length && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (event.repeat) return; // we drive our own cadence; ignore the OS key-repeat
      startGlide(event.key);
    }
    return;
  }

  if (event.key === "Escape" && isFogRibbonOpen()) {
    closeFogRibbon();
    return;
  }
  if (event.target?.matches?.("input, button, textarea, select")) return;

  const drawingPolygon = ui.mode === "polygon" || ui.mode === "namedPolygon";
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === "z") {
    event.preventDefault();
    // While placing a polygon, Ctrl+Z removes just the last point you dropped,
    // so a single misclick doesn't scrap the whole shape (or earlier committed work).
    if (!event.shiftKey && drawingPolygon && tools.drawingRoom.length) {
      tools.drawingRoom.pop();
      render();
      return;
    }
    if (!event.shiftKey && ui.mode === "draw" && tools.drawingObstacle.length) {
      tools.drawingObstacle.pop();
      render();
      return;
    }
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (ctrl && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }

  // Backspace also removes the last placed polygon point (intuitive while drawing).
  if ((event.key === "Backspace" || event.key === "Delete") && drawingPolygon && tools.drawingRoom.length) {
    event.preventDefault();
    tools.drawingRoom.pop();
    render();
    return;
  }
  if ((event.key === "Backspace" || event.key === "Delete") && ui.mode === "draw" && tools.drawingObstacle.length) {
    event.preventDefault();
    tools.drawingObstacle.pop();
    render();
    return;
  }

  // A selected token (Move mode) nudges one grid cell per arrow press, snapped to grid.
  if (sel.token && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    nudgeSelectedToken(event.key);
    return;
  }
  if (sel.token && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    pushHistory();
    const removedTokenId = sel.token.id;
    state.tokens = state.tokens.filter((t) => t !== sel.token);
    sel.token = null;
    removeCombatantByToken(removedTokenId);
    renderAndSync();
    return;
  }
  if (sel.image && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    pushHistory();
    state.images = state.images.filter((im) => im !== sel.image);
    sel.image = null;
    updateSelectionPanels();
    renderAndSync();
    return;
  }
  if (sel.note && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    pushHistory();
    state.notes = state.notes.filter((n) => n !== sel.note);
    sel.note = null;
    render(); // notes are GM-only
    return;
  }
  if (event.key === "Enter" && drawingPolygon) {
    event.preventDefault();
    finishRoom();
    return;
  }
  if (event.key === "Enter" && ui.mode === "draw") {
    event.preventDefault();
    finishObstacle();
    return;
  }
  if (event.key === "Escape" && drawingPolygon && tools.drawingRoom.length) {
    event.preventDefault();
    tools.drawingRoom = [];
    render();
    return;
  }
  if (event.key === "Escape" && ui.mode === "draw" && tools.drawingObstacle.length) {
    event.preventDefault();
    tools.drawingObstacle = [];
    render();
    return;
  }

  const shortcuts = { v: "pan", h: "pan", p: "polygon", n: "namedPolygon", b: "brush", e: "eraser", t: "token", a: "aoe", m: "measure", s: "stair", g: "mapLink", d: "draw", l: "light" };
  const key = event.key.toLowerCase();
  if (shortcuts[key]) {
    setMode(shortcuts[key]);
    return;
  }
  if (key === "f") fitMap(true);
  if (key === "[") adjustBrush(-10);
  if (key === "]") adjustBrush(10);
}

function adjustBrush(delta) {
  if (!["brush", "eraser"].includes(ui.mode)) return;
  const next = Math.min(Number(controls.brushSize.max), Math.max(Number(controls.brushSize.min), state.fog.toolSize + delta));
  state.fog.toolSize = next;
  controls.brushSize.value = next;
  render();
}

// ----- Obstacle geometry (Draw Mode) -----


// Commit the in-progress polyline as an obstacle of the current kind. Points convert to cell units
// (the step-3 bridge) so geometry is resolution-independent and DTT-import-compatible.
function finishObstacle() {
  if (isPlayer || tools.drawingObstacle.length < 2) return;
  pushHistory();
  const obstacle = {
    id: uuid(),
    kind: tools.obstacleKind,
    points: tools.drawingObstacle.map((p) => [p.x, p.y]),
    ...obstacleDefaults(tools.obstacleKind),
    defaultOpen: false,
  };
  state.obstacles.push(obstacle);
  invalidateCast();
  tools.drawingObstacle = [];
  renderAndSync();
}



// ---------------------------------------------------------------------------
// Casting engine (step 5a). A 2D visibility polygon cast from a point against the
// floor's sight-blocking obstacle segments. Nothing consumes the polygon yet beyond
// the GM debug overlay below — line-of-sight (5b), fog reveal (5c) and lighting (5d)
// will ride on this same routine. Coordinates are NATIVE px throughout (obstacles, placed
// lights, tokens, and notes are all stored in native px, locked to the image).
//
// Power note (Sky is off-grid solar + Pi): a cast is O(rays x segments) and would
// cook the budget if run per frame. So the result is cached and only recomputed when
// the cast origin moves or the sight geometry changes (castVersion). render() only
// ever DRAWS the cached polygon — it never casts in the hot path.
// ---------------------------------------------------------------------------




// ---- token movement collision (wall-collision) ----------------------------------------------
// Native-space segments that block movement: every obstacle with blocksMove (today all kinds),
// skipping any OPEN door, plus the map boundary. Memoized by castVersion so it rebuilds only when
// geometry changes — and the ob.open check means it cooperates with door-open-close once that lands.

// Token movement collision radius, as a fraction of a cell. Kept under 0.5 so a token still fits
// through a one-cell doorway. This is the radius the old center-path resolveMove lacked: with no
// margin, a token's center could land exactly on a grid-aligned wall (hit at t=1.0, which the scan
// skipped) and then leave through it (hit at t~=0, also skipped), which walked players through walls
// on integer-grid maps like the converted DungeonDraft modules. With a radius the center stops this
// far short of every wall and can never reach, rest on, or cross one.
const COLLIDE_RADIUS_CELLS = 0.4;

// Earliest time t in [0,1] that a circle of radius r centered at p0 and displaced by d first touches
// segment a-b, as { t, nx, ny } with (nx,ny) the unit contact normal pointing back toward p0 — or
// null if the swept circle never reaches it. Tests the segment body (the parallel offset lines, only
// where the closest point projects onto the segment) and both endpoint caps (the moving center vs a
// circle of radius r at a and at b). Reports an immediate hit (t=0) only when p0 already lies within
// r AND d pushes deeper, so a token resting against a wall can still slide along it or step away —
// it just can never cross it.
function sweepCircleSeg(p0, d, a, b, r) {
  let bestT = Infinity, nx = 0, ny = 0;
  const ex = b.x - a.x, ey = b.y - a.y;
  const elen2 = ex * ex + ey * ey;
  if (elen2 > 1e-12) {
    const elen = Math.sqrt(elen2);
    let onx = -ey / elen, ony = ex / elen;                  // a unit normal of the segment
    const s0 = (p0.x - a.x) * onx + (p0.y - a.y) * ony;     // signed distance of p0 to the segment line
    if (s0 < 0) { onx = -onx; ony = -ony; }                 // orient the normal toward p0
    const sn = d.x * onx + d.y * ony;                       // closing rate (negative = moving toward wall)
    const dist = Math.abs(s0);
    let tBody = null;
    if (dist <= r) { if (sn < 0) tBody = 0; }               // already within r and pushing deeper
    else if (sn < -1e-12) tBody = (dist - r) / (-sn);       // reach distance r at this fraction of d
    if (tBody !== null && tBody <= 1 + 1e-9) {
      const cx = p0.x + d.x * tBody, cy = p0.y + d.y * tBody;
      const u = ((cx - a.x) * ex + (cy - a.y) * ey) / elen2; // projection onto the segment
      if (u >= 0 && u <= 1 && tBody < bestT) { bestT = tBody; nx = onx; ny = ony; }
    }
  }
  for (const c of [a, b]) {                                  // endpoint caps: moving center vs circle r
    const fx = p0.x - c.x, fy = p0.y - c.y;
    const A = d.x * d.x + d.y * d.y;
    if (A < 1e-12) continue;
    const B = 2 * (fx * d.x + fy * d.y);
    const C = fx * fx + fy * fy - r * r;
    if (C <= 0) {                                            // p0 already within r of this endpoint
      if (B < 0 && bestT > 0) { const m = Math.hypot(fx, fy) || 1; bestT = 0; nx = fx / m; ny = fy / m; }
      continue;
    }
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / (2 * A);              // earliest root (entering the cap)
    if (t >= 0 && t <= 1 + 1e-9 && t < bestT) {
      const hx = p0.x + d.x * t, hy = p0.y + d.y * t;
      const m = Math.hypot(hx - c.x, hy - c.y) || 1;
      bestT = t; nx = (hx - c.x) / m; ny = (hy - c.y) / m;
    }
  }
  if (bestT === Infinity) return null;
  return { t: Math.max(0, bestT), nx, ny };
}

// Earliest wall the swept token (center origin, radius r, displacement move) reaches, as
// { t, nx, ny }, or null if the whole sweep is clear. Replaces the old point-vs-segment rayHit scan.
function firstMoveHit(origin, move, segs, r) {
  let best = null;
  for (const seg of segs) {
    const h = sweepCircleSeg(origin, move, seg.a, seg.b, r);
    if (h && h.t <= 1 + 1e-9 && (!best || h.t < best.t)) best = h;
  }
  return best;
}

// Resolve a token move from -> to against move-blocking walls as a circle of radius r: stop the
// center r short of the first wall the body reaches, then slide the leftover motion along that wall
// (one pass, so a perpendicular wall still stops the slide). The radius is what closes the grid-
// aligned walk-through — the center can never reach, rest on, or cross a wall.
function resolveMove(from, to) {
  const segs = moveSegments();
  const r = COLLIDE_RADIUS_CELLS * pxPerCellNative();
  let cur = { x: from.x, y: from.y };
  let move = { x: to.x - from.x, y: to.y - from.y };
  for (let pass = 0; pass < 2; pass++) {
    if (Math.hypot(move.x, move.y) < 1e-9) break;
    const hit = firstMoveHit(cur, move, segs, r);
    if (!hit) { cur = { x: cur.x + move.x, y: cur.y + move.y }; break; } // clear path
    const adv = Math.max(0, hit.t - 1e-4);                  // stop a hair before contact
    cur = { x: cur.x + move.x * adv, y: cur.y + move.y * adv };
    if (pass === 1) break;                                  // one slide pass only
    // Slide: project the leftover motion onto the wall tangent (perpendicular to the contact normal).
    const rem = { x: move.x * (1 - adv), y: move.y * (1 - adv) };
    const tx = -hit.ny, ty = hit.nx;
    const d = rem.x * tx + rem.y * ty;
    move = { x: tx * d, y: ty * d };
  }
  return cur;
}





// Player-view only: black out everything outside the players' shared field of view by filling
// the mask black, cutting out each player token's visibility polygon, then drawing it over the
// scene. Fails open — with no player tokens on the floor, nothing is hidden.
// ---------------------------------------------------------------------------
// Lighting (5d-1). Placed lights illuminate their radius, occluded by light-blocking walls.
// When darkness is on, the player only sees line-of-sight INTERSECT lit. Cached like sight.
// ---------------------------------------------------------------------------




// Inner share of a light's radius held at full brightness; the outer share fades to the rim.
// Render-only tuning — not persisted, no schema impact. 0.5 = bright to half radius, dim beyond.


// Add / find / delete placed lights (GM only). Stored in native px (decoupled from the display
// grid) so they stay locked to the image; radius converts the cell-based tools.lightRadius at place time.
function addLight(native) {
  if (isPlayer) return;
  pushHistory();
  state.lights.push({ id: uuid(), x: native.x, y: native.y, radius: tools.lightRadius * pxPerCellNative(), color: tools.lightColor });
  invalidateCast();
  renderAndSync();
}




// Wipe explored memory for the current floor (the player's "Reset explored"). GM relays this to
// the player window, where the actual memory lives.
function resetExplored() {
  exploredMasks.delete(state.currentFloorId);
}



function finishRoom() {
  if (isPlayer || tools.drawingRoom.length < 3) return;
  pushHistory();
  const room = {
    id: uuid(),
    points: tools.drawingRoom.map((point) => ({ ...point })),
    revealed: false,
    name: "",
  };
  state.fog.rooms.push(room);
  tools.drawingRoom = [];
  fogBuf.dirty = true;
  renderAndSync();
  if (ui.mode === "namedPolygon") {
    // Defer one tick so the Enter keypress that finished the polygon can't also submit the dialog.
    setTimeout(() => promptRoomName(room), 0);
  }
}

// GM-only: ask for a name for a freshly placed fog area. The name rides along in state
// (so it survives save/undo) but is only ever drawn on the GM screen.
function promptRoomName(room) {
  if (!controls.nameDialog || !controls.roomNameInput) return;
  controls.roomNameInput.value = room.name || "";
  controls.nameDialog.returnValue = "";
  controls.nameDialog.addEventListener(
    "close",
    () => {
      if (controls.nameDialog.returnValue === "save") {
        room.name = controls.roomNameInput.value.trim();
      }
      render();
      broadcastState();
    },
    { once: true },
  );
  controls.nameDialog.showModal();
  controls.roomNameInput.focus();
  controls.roomNameInput.select();
}



/* ----------------------------- misc ----------------------------- */

function loadImage(src, afterLoad) {
  scene.map = new Image();
  scene.map.onload = afterLoad;
  scene.map.src = src;
}

function loadSplashImage(src, afterLoad) {
  scene.splash = new Image();
  scene.splash.onload = afterLoad;
  scene.splash.src = src;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}


setup();
