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
  isPlayer, DEFAULT_GM_FOG_OPACITY, INITIAL_FLOOR_ID, makeFloor, state, normalizeInput, uuid, escapeHtml,
  playerCam, tools, cur, hooks, sel, fogBuf,
  castCache, castFrameKeys, lightFrameKeys,
} from "./state.js";
import {
  saveMapRecord, listMapRecords, deleteMapRecord, saveModuleRecord, listModuleRecords, getModuleRecord, deleteModuleRecord, saveSessionRecord,
  listSessionRecords, getSessionRecord, deleteSessionRecord, saveTokenRecord, listTokenRecords, deleteTokenRecord, putImage, getImageRecord,
  getImage,
} from "./db.js";
import { readZip, parseDtt } from "./dtt.js";
import {
  simplifyPolyline, distToSegment, pointInPolygon, gridCellNative, pxPerCellNative, cellsToNative, tokenRadius, snapToGrid,
  snapNative, worldDims, activeView, fitScaleFor, viewTransform, clientToCanvasPoint, currentViewRotation, keepUpright,
  screenToNative, nativeToScreen, followView, cellWorldPx,
} from "./geometry.js";
import {
  drawAoeTemplate, drawMeasureLine, drawMeasureLabel, drawCalibrationDraft, updateCalibrationUI, updateMeasureCalibrateRow,
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

// Wire the orchestration hooks now that the render/sync/relay functions exist (all hoisted).
hooks.render = render;
hooks.renderAndSync = renderAndSync;
hooks.relay = relay;

let mapImage = new Image();
let splashImage = new Image();
let mode = "pan";
let drawingRoom = [];
let drawingObstacle = []; // in-progress obstacle polyline (native px) while drawing in Draw Mode
let obstacleKind = "wall"; // kind applied to newly drawn obstacles
let showObstacles = true; // GM-only obstacle overlay toggle ("Walls Visible to DM")
// Area of effect is a live "hover template" (not placed): the shape follows the cursor
// and is mirrored to the player display in real time.
let aoeSyncQueued = false;
const AOE_PRESETS = { circle: [5, 10, 15, 20], square: [10, 20, 30], cone: [15, 30] };
let selectedToken = null; // token highlighted in Move mode for arrow-key nudging (GM only)
let selectedPlayerTokens = []; // player-screen selection SET (tap, shift-click, or marquee; arrow-moves as a group)
let playerMarquee = null; // active rubber-band box on the player screen, {x0,y0,x1,y1,additive} in canvas px
const CAM_EASE = 0.15; // follow-camera smoothing: fraction of the gap closed per frame (higher = snappier)
const CAM_EASE_EPS = 0.5; // px: how close (center) counts as "arrived" so the easing loop can stop
const CAM_EASE_K_EPS = 0.001; // scale: how close (zoom) counts as "arrived"
let camEaseRaf = 0; // rAF handle for the on-demand camera-easing loop (0 = stopped)
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
let draggingFrame = false; // GM is dragging the player-view frame to pan the player display
let dragGrab = { dx: 0, dy: 0 }; // offset from cursor to object center while dragging images/notes/frame
let groupDragOffsets = null; // [{token,dx,dy}] formation captured at grab, for a player group-drag
let dragGrabbed = false; // a token-grab has been relayed for the current player pointer-drag
let lastPointer = { clientX: 0, clientY: 0 };
let castDebug = false; // GM-only: draw the visibility polygon cast from the selected token
let viewSyncQueued = false;

const undoStack = [];
const redoStack = [];

let playerWindow = null; // handle to the popup (GM side), used as a direct postMessage fallback
let seenMids = []; // recently handled message ids, for de-duplicating the two transports
let playerViewport = null; // {w,h} CSS px the player reports, used to draw the player frame
let showPlayerFrame = true; // GM-only: draw a red rectangle of what the players currently see
let playerFrameColor = "#e24a4a"; // GM-only: color of that rectangle
let playerFrameOpacity = 0.9; // GM-only: opacity of that rectangle
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
    if (source) playerWindow = source;
    broadcastAssets();
    broadcastState();
  }
  if (message.type === "request-assets" && !isPlayer) broadcastAssets();
  if (message.type === "viewport" && !isPlayer) {
    playerViewport = { w: message.w, h: message.h };
    render();
  }
  if (message.type === "token-grab" && !isPlayer) {
    // Snapshot once at the start of a remote drag so the whole move is one undo step.
    pushHistory();
  }
  if (message.type === "token-move" && !isPlayer) {
    // Live position during a drag: update and render locally, but do NOT broadcast — a
    // full state sync mid-drag would replace the player's tokens and orphan its drag.
    const token = state.tokens.find((t) => t.id === message.id);
    if (token) {
      token.x = message.x;
      token.y = message.y;
      render();
    }
  }
  if (message.type === "token-drop" && !isPlayer) {
    // Commit a player move: pick the target cell (nudged to the nearest free one so no two tokens
    // share a cell), clamp the move to it so it can't cross a wall, then broadcast to all displays.
    // The GM's own drags don't come through here, so the GM stays free to place anything anywhere.
    const token = state.tokens.find((t) => t.id === message.id);
    if (token) {
      const snapped = snapNative({ x: message.x, y: message.y });
      const free = nearestFreeCell(snapped, token);
      const dest = resolveMove({ x: message.x, y: message.y }, free);
      token.x = dest.x;
      token.y = dest.y;
      renderAndSync();
    }
  }
}

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
  const target = isPlayer ? window.opener : playerWindow;
  if (target && !target.closed) {
    try {
      target.postMessage(message, "*");
    } catch {}
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
    if (mode === "aoe" && !isPlayer && tools.aoe.template.visible) {
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
  controls.drawMode?.addEventListener("click", () => setMode("draw"));
  controls.lightMode?.addEventListener("click", () => setMode("light"));
  controls.obstacleKind?.addEventListener("change", () => { obstacleKind = controls.obstacleKind.value; });
  controls.showObstacles?.addEventListener("change", () => { showObstacles = controls.showObstacles.checked; render(); });
  controls.lightRadius?.addEventListener("input", () => {
    tools.lightRadius = Number(controls.lightRadius.value) || 1;
    if (controls.lightRadiusVal) controls.lightRadiusVal.textContent = tools.lightRadius;
  });
  controls.tokenLight?.addEventListener("input", () => {
    if (controls.tokenLightVal) controls.tokenLightVal.textContent = Number(controls.tokenLight.value) || 0;
  });
  controls.tokenSelLight?.addEventListener("input", () => {
    if (!selectedToken) return;
    selectedToken.light = Number(controls.tokenSelLight.value) || 0;
    if (controls.tokenSelLightVal) controls.tokenSelLightVal.textContent = selectedToken.light;
    renderAndSync();
  });
  controls.darknessEnabled?.addEventListener("input", () => { state.los.darkness = controls.darknessEnabled.checked; renderAndSync(); });
  controls.castDebug?.addEventListener("change", () => { castDebug = controls.castDebug.checked; render(); });

  // Floor navigation
  controls.floorUp?.addEventListener("click", () => goToFloor(currentFloorIndex() + 1));
  controls.floorDown?.addEventListener("click", () => goToFloor(currentFloorIndex() - 1));
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
    showPlayerFrame = controls.playerFrameToggle.checked;
    render();
  });
  controls.playerFrameColor?.addEventListener("input", () => {
    playerFrameColor = controls.playerFrameColor.value;
    render();
  });
  controls.playerFrameOpacity?.addEventListener("input", () => {
    playerFrameOpacity = parseFloat(controls.playerFrameOpacity.value);
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
    if (!selectedToken) return;
    selectedToken.type = controls.tokenSelType.value;
    renderAndSync();
  });
  controls.tokenSelLabel?.addEventListener("input", () => {
    if (!selectedToken) return;
    selectedToken.label = controls.tokenSelLabel.value.trim();
    renderAndSync();
  });
  controls.tokenSelColor?.addEventListener("input", () => {
    if (!selectedToken) return;
    selectedToken.color = controls.tokenSelColor.value;
    renderAndSync();
  });
  controls.tokenSelCells?.addEventListener("input", () => {
    if (!selectedToken) return;
    selectedToken.cells = Number(controls.tokenSelCells.value) || 1;
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
  playerWindow = window.open(url, "fog-table-player", "popup=yes,width=1280,height=720");
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
  drawingRoom = [];
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  loadImage(state.imageData, () => {
    state.imageWidth = mapImage.naturalWidth;
    state.imageHeight = mapImage.naturalHeight;
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

// How aggressively imported polylines are thinned, in CELLS (resolution-independent). 0.2 = a
// 1/5-cell deviation: invisible for line-of-sight, but it cuts a dense module like Caves of Chaos
// from ~8,600 wall segments to ~1,900 (~20x cheaper cast). Tune here if a map needs more/less.
const DTT_SIMPLIFY_TOLERANCE = 0.2;


// Map a parsed DTT's six obstacle kinds into the obstacle store. DTT polylines are already open
// polylines in cell coordinates — the exact shape state.obstacles holds — so geometry maps
// directly; only Douglas-Peucker simplification (simplifyPolyline) thins the dense polylines. Each record draws its blocking rules from obstacleDefaults(kind), identical to a
// hand-drawn obstacle (so wall/object/ethereal share the default profile, windows pass sight and
// light, invisibles block but don't render, doors are openable). Replaces the store wholesale: a
// fresh module import never appends to whatever was on the map before.
function importObstacles(dtt) {
  const KINDS = [
    ["walls", "wall"],
    ["doors", "door"],
    ["windows", "window"],
    ["objects", "object"],
    ["ethereals", "ethereal"],
    ["invisibles", "invisible"],
  ];
  const obstacles = [];
  for (const [src, kind] of KINDS) {
    for (const poly of dtt[src] || []) {
      if (!Array.isArray(poly) || poly.length < 2) continue;
      obstacles.push({
        id: uuid(),
        kind,
        // Simplify in cell space (tolerance is in cells), then bake to native px so geometry is
        // locked to the image and independent of the display grid (decouple-walls-from-grid).
        points: simplifyPolyline(poly, DTT_SIMPLIFY_TOLERANCE).map((p) => {
          const n = cellsToNative({ x: p[0], y: p[1] });
          return [n.x, n.y];
        }),
        ...obstacleDefaults(kind),
        defaultOpen: false,
      });
    }
  }
  state.obstacles = obstacles;
}

// Named token colors seen in DTT exports map to vwag fill colors; anything unknown falls back to
// the default token amber. (Samples only use "blue", but a small table keeps imports sane.)
const DTT_TOKEN_COLORS = {
  red: "#e24a4a", blue: "#3b82f6", green: "#3aa655", yellow: "#d6a94d",
  orange: "#e08a3c", purple: "#8b5cf6", white: "#e8e8e8", black: "#222222",
  cyan: "#3ec6c6", magenta: "#d4537e", gray: "#9aa0a6", grey: "#9aa0a6",
};

// DTT token types collapse to vwag's three: player / npc / monster (enemy and anything else read
// as monster).
function dttTokenType(t) {
  if (t === "player") return "player";
  if (t === "npc") return "npc";
  return "monster";
}

// Import placed lights. DTT positions are cells and radii are feet (÷5 = cells); both are baked to
// native px here so lights lock to the image like obstacles. Inactive lights are skipped.
function importLights(dtt) {
  const lights = [];
  for (const l of (dtt.save && dtt.save.lights) || []) {
    if (l.active === false) continue;
    const p = l.position || {};
    const n = cellsToNative({ x: p.x || 0, y: p.y || 0 });
    lights.push({ id: uuid(), x: n.x, y: n.y, radius: ((l.radius || 0) / 5) * pxPerCellNative() });
  }
  state.lights = lights;
}

// Import tokens. Position converts cells -> native px (vwag tokens carry native coords); size and
// torch radii are feet -> cells (/5). A torch_on token carries a light of dim_radius cells. The
// token art path is a local file outside the zip, so images import blank — type + color stand in.
function importTokens(dtt) {
  const tokens = [];
  for (const t of (dtt.save && dtt.save.tokens) || []) {
    const p = t.position || {};
    const n = cellsToNative({ x: p.x || 0, y: p.y || 0 });
    tokens.push({
      id: uuid(),
      x: n.x,
      y: n.y,
      cells: Math.max(1, Math.round((t.size || 5) / 5)),
      color: DTT_TOKEN_COLORS[t.border_color] || "#d6a94d",
      label: "",
      type: dttTokenType(t.type),
      light: t.torch_on ? (t.dim_radius || 0) / 5 : 0,
      image: "",
    });
  }
  state.tokens = tokens;
}

// Import room labels as GM-only floating notes. Position converts cells -> native px; text is 1:1.
// (DTT calls these "notes"; they map to vwag's notes feature, not the reserved pins field, which
// stays for Encounter-Area linkage.)
function importNotes(dtt) {
  const notes = [];
  for (const nt of (dtt.save && dtt.save.notes) || []) {
    const p = nt.position || {};
    const n = cellsToNative({ x: p.x || 0, y: p.y || 0 });
    notes.push({ id: uuid(), x: n.x, y: n.y, text: nt.text || "", scale: 1 });
  }
  state.notes = notes;
}

// Orchestrate a full DTT import into the live stores: geometry (6b), lights + tokens (6c), room
// notes (6d), and the line-of-sight flag. A single cast invalidation covers all of them; the LoS
// checkbox re-syncs when installMap calls refreshFloorUI right after this runs.
function importDtt(dtt) {
  importObstacles(dtt);
  importLights(dtt);
  importTokens(dtt);
  importNotes(dtt);
  if (dtt.save && typeof dtt.save.line_of_sight === "boolean") {
    state.los.enabled = dtt.save.line_of_sight;
  }
  invalidateCast();
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

function makeMapId(name) {
  return name.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function validateSessionData(data) {
  if (!data || ![APP_NAME, LEGACY_APP_NAME].includes(data.app) || !data.state) {
    throw new Error("invalid or unsupported battlemap save");
  }
  if (!data.state.grid || !data.state.fog) {
    throw new Error("the save file is missing required map data");
  }
  return migrateState(data.state, data.version || 1);
}

function migrateState(snapshot, version) {
  // v1 -> v2: fog/room points were stored in scaled-world coords (native x map.scale).
  if (version < 2) {
    const scale = snapshot.map?.scale || 1;
    if (scale !== 1 && snapshot.fog) {
      (snapshot.fog.rooms || []).forEach((room) => {
        room.points = (room.points || []).map((p) => ({ x: p.x / scale, y: p.y / scale }));
      });
      (snapshot.fog.strokes || []).forEach((stroke) => {
        stroke.points = (stroke.points || []).map((p) => ({ x: p.x / scale, y: p.y / scale }));
        stroke.size = stroke.size / scale;
      });
    }
    snapshot._refit = true; // old view used a different model; refit on load
  }
  snapshot.tokens = snapshot.tokens || [];
  if (snapshot.blackout === undefined) snapshot.blackout = false;

  // v2 -> v3: a single map becomes the first (and only) floor.
  if (!Array.isArray(snapshot.floors) || !snapshot.floors.length) {
    snapshot.floors = [
      {
        id: INITIAL_FLOOR_ID,
        imageId: snapshot.imageId || "",
        imageData: snapshot.imageData || "",
        imageName: snapshot.imageName || "",
        imageWidth: snapshot.imageWidth || 0,
        imageHeight: snapshot.imageHeight || 0,
        mapScale: snapshot.map?.scale || 1,
        rooms: snapshot.fog?.rooms || [],
        strokes: snapshot.fog?.strokes || [],
        tokens: snapshot.tokens || [],
        stairs: [],
        view: { ...(snapshot.view || { scale: 1, cx: 0, cy: 0 }) },
      },
    ];
    snapshot.currentFloorId = INITIAL_FLOOR_ID;
  }
  return snapshot;
}

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

async function loadLibraryMap(id) {
  try {
    const session = await getSessionRecord(id);
    if (!session) throw new Error("saved game not found");
    const module = await getModuleRecord(session.moduleId || id);
    if (!module) throw new Error("the map module for this saved game is missing");
    const snapshot = mergeModuleSession(module, session);
    await hydrateFloorImages(snapshot); // floors carry only imageId; pull the bytes back in
    drawingRoom = [];
    fogBuf.activeStroke = null;
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButtons();
    loadSnapshot(snapshot);
    syncControlsFromState();
    broadcastAssets();
    renderAndSync();
    controls.libraryDialog.close();
  } catch (error) {
    window.alert(`Could not load this map: ${error.message}`);
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

// Fill each floor's imageData back in from the image store (records carry only imageId).
async function hydrateFloorImages(snapshot) {
  const floors = Array.isArray(snapshot.floors) ? snapshot.floors : [];
  for (const floor of floors) {
    if (!floor.imageData && floor.imageId) {
      floor.imageData = await getImage(floor.imageId);
    }
  }
  const current = floors.find((f) => f.id === (snapshot.currentFloorId || (floors[0] && floors[0].id)));
  if (current) {
    snapshot.imageId = current.imageId || snapshot.imageId;
    snapshot.imageData = current.imageData || snapshot.imageData;
  }
}

/* ----------------------------- module / session split ----------------------------- */

// Partition a full live-state snapshot into an authored module body + a session body. Floors
// split by id: the authored half (image ref + dimensions + scale + stairs) goes to the module,
// the play half (fog/tokens/dropped images/notes/view) goes to the session. Neither carries the
// image bytes — those live in the image store, keyed by imageId.
function splitState(stateObj) {
  const floors = stateObj.floors || [];
  const moduleFloors = floors.map((f) => ({
    id: f.id,
    imageId: f.imageId || "",
    imageName: f.imageName || "",
    imageWidth: f.imageWidth || 0,
    imageHeight: f.imageHeight || 0,
    mapScale: f.mapScale || 1,
    stairs: JSON.parse(JSON.stringify(f.stairs || [])),
    obstacles: JSON.parse(JSON.stringify(f.obstacles || [])),
    lights: JSON.parse(JSON.stringify(f.lights || [])),
  }));
  const sessionFloors = floors.map((f) => ({
    id: f.id,
    rooms: JSON.parse(JSON.stringify(f.rooms || [])),
    strokes: JSON.parse(JSON.stringify(f.strokes || [])),
    tokens: JSON.parse(JSON.stringify(f.tokens || [])),
    images: JSON.parse(JSON.stringify(f.images || [])),
    notes: JSON.parse(JSON.stringify(f.notes || [])),
    view: { ...(f.view || { scale: 1, cx: 0, cy: 0, rotation: 0 }) },
  }));
  const primaryModuleFloor = moduleFloors.find((f) => f.imageWidth) || moduleFloors[0] || null;
  const moduleGrid = JSON.parse(JSON.stringify(stateObj.grid || {}));
  Object.assign(moduleGrid, deriveCellGrid(moduleGrid, stateObj.measure || {}, primaryModuleFloor));
  const module = {
    grid: moduleGrid,
    measure: JSON.parse(JSON.stringify(stateObj.measure || {})),
    stairColor: stateObj.stairColor || "#ffffff",
    floors: moduleFloors,
    // Forward-empty — filled by later steps (room pins, VWAG linkage). Obstacle geometry and
    // placed lights are per-floor (module.floors[].obstacles / .lights), authored on the map.
    pins: [],
    ambient: { timeOfDay: 12 },
    vwag: {},
  };
  const session = {
    blackout: Boolean(stateObj.blackout),
    los: JSON.parse(JSON.stringify(stateObj.los || { enabled: false })),
    splash: JSON.parse(JSON.stringify(stateObj.splash || { enabled: false, imageData: "", imageName: "" })),
    initiative: JSON.parse(JSON.stringify(stateObj.initiative || {})),
    playerView: JSON.parse(JSON.stringify(stateObj.playerView || {})),
    currentFloorId: stateObj.currentFloorId,
    openDoors: [], // session-tracked open door ids (forward; the toggle that uses it is step 5)
    floorPosition: stateObj.floorPosition || 1,
    floorCount: stateObj.floorCount || floors.length || 1,
    fog: {
      gmColor: stateObj.fog?.gmColor || "#080909",
      gmOpacity: stateObj.fog?.gmOpacity ?? DEFAULT_GM_FOG_OPACITY,
      toolSize: stateObj.fog?.toolSize ?? 70,
      toolShape: stateObj.fog?.toolShape ?? "round",
      stampShape: stateObj.fog?.stampShape ?? "rectangle",
    },
    floors: sessionFloors,
  };
  return { module, session };
}

// Recombine a module + session into a single snapshot loadSnapshot() can consume. Floors are
// re-merged by id; imageData is left blank for hydrateFloorImages() to fill from the store.
function mergeModuleSession(module, session) {
  const sessionById = new Map((session.floors || []).map((f) => [f.id, f]));
  const floors = (module.floors || []).map((mf) => {
    const sf = sessionById.get(mf.id) || {};
    return {
      id: mf.id,
      imageId: mf.imageId || "",
      imageData: "",
      imageName: mf.imageName || "",
      imageWidth: mf.imageWidth || 0,
      imageHeight: mf.imageHeight || 0,
      mapScale: mf.mapScale || 1,
      stairs: JSON.parse(JSON.stringify(mf.stairs || [])),
      obstacles: JSON.parse(JSON.stringify(mf.obstacles || [])),
      lights: JSON.parse(JSON.stringify(mf.lights || [])),
      rooms: JSON.parse(JSON.stringify(sf.rooms || [])),
      strokes: JSON.parse(JSON.stringify(sf.strokes || [])),
      tokens: JSON.parse(JSON.stringify(sf.tokens || [])),
      images: JSON.parse(JSON.stringify(sf.images || [])),
      notes: JSON.parse(JSON.stringify(sf.notes || [])),
      view: { ...(sf.view || { scale: 1, cx: 0, cy: 0, rotation: 0 }) },
    };
  });
  return {
    grid: JSON.parse(JSON.stringify(module.grid || {})),
    measure: JSON.parse(JSON.stringify(module.measure || {})),
    stairColor: module.stairColor || "#ffffff",
    blackout: Boolean(session.blackout),
    los: JSON.parse(JSON.stringify(session.los || { enabled: false })),
    splash: JSON.parse(JSON.stringify(session.splash || { enabled: false, imageData: "", imageName: "" })),
    initiative: JSON.parse(JSON.stringify(session.initiative || {})),
    playerView: JSON.parse(JSON.stringify(session.playerView || {})),
    fog: {
      rooms: [],
      strokes: [],
      gmColor: session.fog?.gmColor || "#080909",
      gmOpacity: session.fog?.gmOpacity ?? DEFAULT_GM_FOG_OPACITY,
      toolSize: session.fog?.toolSize ?? 70,
      toolShape: session.fog?.toolShape ?? "round",
      stampShape: session.fog?.stampShape ?? "rectangle",
    },
    currentFloorId: session.currentFloorId || (floors[0] && floors[0].id),
    floorPosition: session.floorPosition || 1,
    floorCount: session.floorCount || floors.length,
    floors,
  };
}

// One-time, idempotent: drain the legacy single-record map store into module + session pairs.
// Runs on GM startup and after a legacy import. Per record: normalize its shape, de-embed any
// still-inline image bytes into the image store, split it, write the pair, delete the original.
// Best-effort per record so a single bad record never blocks startup.
async function migrateMapsToModulesAndSessions() {
  let records;
  try {
    records = await listMapRecords();
  } catch {
    return;
  }
  if (!Array.isArray(records) || !records.length) return;
  for (const record of records) {
    try {
      if (!record || !record.id || !record.state) continue;
      const snapshot = validateSessionData(record); // app check + shape migration -> floors guaranteed
      for (const floor of snapshot.floors || []) {
        if (floor.imageData) {
          if (!floor.imageId) floor.imageId = uuid();
          await putImage(floor.imageId, floor.imageData);
        }
      }
      const { module, session } = splitState(snapshot);
      const now = record.savedAt || new Date().toISOString();
      const name = record.name || record.id;
      Object.assign(module, { id: record.id, app: APP_NAME, version: SAVE_FILE_VERSION, kind: "module", name, savedAt: now });
      Object.assign(session, { id: record.id, moduleId: record.id, app: APP_NAME, version: SAVE_FILE_VERSION, kind: "session", name, savedAt: now });
      await saveModuleRecord(module);
      await saveSessionRecord(session);
      await deleteMapRecord(record.id);
    } catch {
      // Leave this record in place for a later attempt; never block startup.
    }
  }
}

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

function loadSnapshot(snapshot) {
  // Shared / global settings.
  Object.assign(state.splash, snapshot.splash || { enabled: false, imageData: "", imageName: "" });
  state.blackout = Boolean(snapshot.blackout);
  if (snapshot.los) Object.assign(state.los, snapshot.los);
  Object.assign(state.grid, snapshot.grid);
  if (state.grid.snap === undefined) state.grid.snap = true;
  if (snapshot.stairColor) state.stairColor = snapshot.stairColor;
  if (snapshot.measure) Object.assign(state.measure, snapshot.measure);
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
    applyFloor(state.floors.find((f) => f.id === state.currentFloorId) || state.floors[0]);
  } else {
    // Lightweight sync (player) — only the current floor's live fields are present.
    Object.assign(state.map, snapshot.map || { scale: 1 });
    state.fog.rooms = snapshot.fog?.rooms || [];
    state.fog.strokes = snapshot.fog?.strokes || [];
    state.tokens = Array.isArray(snapshot.tokens) ? snapshot.tokens : [];
    state.stairs = Array.isArray(snapshot.stairs) ? snapshot.stairs : [];
    // Obstacles now ride to the player too: the player computes its own line-of-sight locally
    // (cast against these walls), so without them its visibility would be the whole map.
    state.obstacles = Array.isArray(snapshot.obstacles) ? snapshot.obstacles : [];
    state.lights = Array.isArray(snapshot.lights) ? snapshot.lights : [];
    invalidateCast();
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
    if (isPlayer && selectedPlayerTokens.length) {
      // Tokens are fresh objects after a sync; re-point each selected token to its new object by id
      // and drop any that the GM removed, so the rings and arrow-march keep working.
      selectedPlayerTokens = selectedPlayerTokens
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
    mapImage = new Image();
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
      state.imageWidth = mapImage.naturalWidth;
      state.imageHeight = mapImage.naturalHeight;
      fogBuf.dirty = true;
      render();
    });
  }
  if (state.splash.imageData) loadSplashImage(state.splash.imageData, render);
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
  render();
}

// Player side: the player display is fully GM-driven, so it just adopts whatever
// playerView the GM sends (framing + rotation).
function applyIncomingPlayerView(pv) {
  Object.assign(state.playerView, pv);
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
  controls.gridOpacity.value = state.grid.opacity;
  controls.splashEnabled.checked = state.splash.enabled;
  controls.blackoutEnabled.checked = state.blackout;
  if (controls.losEnabled) controls.losEnabled.checked = state.los.enabled;
  if (controls.losOptions) controls.losOptions.classList.toggle("hidden", !state.los.enabled);
  if (controls.darknessEnabled) controls.darknessEnabled.checked = Boolean(state.los.darkness);
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
  render();
  if (sync) broadcastState();
}

/* ----------------------------- floor management ----------------------------- */

// Flush active-floor mutable fields back into the floor record.
function captureCurrentFloor() {
  const floor = state.floors.find((f) => f.id === state.currentFloorId);
  if (!floor) return;
  floor.imageId = state.imageId;
  floor.imageData = state.imageData;
  floor.imageName = state.imageName;
  floor.imageWidth = state.imageWidth;
  floor.imageHeight = state.imageHeight;
  floor.mapScale = state.map.scale;
  floor.rooms = JSON.parse(JSON.stringify(state.fog.rooms));
  floor.strokes = JSON.parse(JSON.stringify(state.fog.strokes));
  floor.tokens = JSON.parse(JSON.stringify(state.tokens));
  floor.stairs = JSON.parse(JSON.stringify(state.stairs));
  floor.obstacles = JSON.parse(JSON.stringify(state.obstacles));
  floor.lights = JSON.parse(JSON.stringify(state.lights));
  floor.images = JSON.parse(JSON.stringify(state.images));
  floor.notes = JSON.parse(JSON.stringify(state.notes));
  floor.view = { ...state.view };
}

// Promote a floor record into the active state fields.
function applyFloor(floor) {
  selectedToken = sel.image = sel.note = null; // these arrays are about to be replaced
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
  state.obstacles = JSON.parse(JSON.stringify(floor.obstacles || []));
  state.lights = JSON.parse(JSON.stringify(floor.lights || []));
  invalidateCast();
  state.images = JSON.parse(JSON.stringify(floor.images || []));
  state.notes = JSON.parse(JSON.stringify(floor.notes || []));
  Object.assign(state.view, floor.view || { scale: 1, cx: 0, cy: 0 });
  state.view.rotation = floor.view?.rotation || 0; // default older floors with no rotation
  fogBuf.dirty = true;
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButtons();
  mapImage = new Image();
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

function currentFloorIndex() {
  return state.floors.findIndex((f) => f.id === state.currentFloorId);
}

function goToFloor(index) {
  if (index < 0 || index >= state.floors.length) return;
  captureCurrentFloor();
  drawingRoom = [];
  fogBuf.activeStroke = null;
  applyFloor(state.floors[index]);
  updatePlayerSliderRanges();
  syncControlsFromState();
  refreshFloorUI();
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
    // Floor level is GM-only information; never reveal it on the player display.
    if (controls.playerFloorBadge) controls.playerFloorBadge.hidden = true;
    return;
  }
  const idx = currentFloorIndex();
  const total = state.floors.length;
  const floor = state.floors[idx];
  if (controls.floorName) controls.floorName.value = floor.name || `Floor ${idx + 1}`;
  if (controls.floorIndicator) {
    controls.floorIndicator.textContent = `${idx + 1} / ${total}`;
    controls.floorIndicator.title = floor.name || `Floor ${idx + 1}`;
  }
  if (controls.floorUp) controls.floorUp.disabled = idx >= total - 1;
  if (controls.floorDown) controls.floorDown.disabled = idx <= 0;
  if (controls.deleteFloor) controls.deleteFloor.disabled = total <= 1;
  if (controls.mapScale) controls.mapScale.value = state.map.scale;
}

/* ----------------------------- stairs ----------------------------- */

function promptStairPlacement(native) {
  if (!controls.stairDialog) return;
  const idx = currentFloorIndex();
  const select = controls.stairFloorSelect;
  if (!select) return;

  // Populate the floor list (exclude the current floor).
  select.replaceChildren();
  state.floors.forEach((floor, i) => {
    if (i === idx) return;
    const opt = document.createElement("option");
    opt.value = floor.id;
    opt.textContent = floor.name || `Floor ${i + 1}`;
    select.appendChild(opt);
  });

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

function drawStairs() {
  if (!state.stairs.length) return;

  const myIdx = !isPlayer && state.floors
    ? state.floors.findIndex((f) => f.id === state.currentFloorId)
    : -1;

  // Marker fills exactly one grid cell — scales with grid size AND zoom, just like tokens.
  const cell = gridCellNative();
  const half = cell / 2;
  // Constant 2px screen line width regardless of zoom.
  const sw = 2 / (cur.k * cur.ms);

  ctx.save();
  const rot = currentViewRotation();

  state.stairs.forEach((stair) => {
    const { x, y } = stair;
    ctx.save();
    keepUpright(x, y, rot); // icon + label stay upright when the map is rotated

    // Determine direction: 1 = going UP (target floor has a higher index), -1 = DOWN.
    let dir = 0;
    if (!isPlayer && myIdx !== -1 && state.floors) {
      const targetIdx = state.floors.findIndex((f) => f.id === stair.targetFloorId);
      if (targetIdx !== -1) dir = targetIdx > myIdx ? 1 : -1;
    }

    // ---- bare stair icon (no box/background) in the tunable stair color ----
    // The Tabler icons are defined in a 24×24 coordinate space; fill ~90% of the cell.
    const stairColor = state.stairColor || "#ffffff";
    const iconFill = cell * 0.90;
    const iconScale = iconFill / 24;
    const iconPad = (cell - iconFill) / 2;

    ctx.save();
    ctx.translate(x - half + iconPad, y - half + iconPad);
    ctx.scale(iconScale, iconScale);
    ctx.strokeStyle = stairColor;
    ctx.lineWidth = 2.4 / (cur.k * cur.ms * iconScale); // stays a constant width on screen
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const icon = dir > 0 ? STAIRS_ICON_UP : dir < 0 ? STAIRS_ICON_DOWN : STAIRS_ICON_NEUTRAL;
    ctx.stroke(icon);
    ctx.restore();

    // ---- optional text label below the square ----
    if (stair.label) {
      ctx.save();
      ctx.font = `600 ${Math.round(half * 0.65)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#f4e8c8";
      ctx.fillText(stair.label, x, y + half + sw * 2);
      ctx.restore();
    }

    // ---- hover highlight outline in stair placement mode (GM only) ----
    if (!isPlayer && mode === "stair") {
      const gap = sw * 3;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - half - gap, y - half - gap, cell + gap * 2, cell + gap * 2);
      ctx.strokeStyle = "rgba(177,195,1,0.50)";
      ctx.lineWidth = sw * 1.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  });

  ctx.restore();
}

function broadcastAssets() {
  if (isPlayer) return;
  // Only the current floor's image is sent — the player follows the GM's active floor,
  // so it never needs the other floors' images.
  relay({
    type: "assets",
    imageId: state.imageId,
    imageData: state.imageData,
    imageName: state.imageName,
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

function renderAndSync() {
  render();
  broadcastState();
}

function renderAndSyncView() {
  render();
  broadcastView();
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
  if (mode === "aoe" && nextMode !== "aoe") {
    tools.aoe.template.visible = false;
    broadcastView();
  }
  mode = nextMode;
  closeFogRibbon();
  drawingRoom = [];
  drawingObstacle = [];
  fogBuf.stampDraft = null;
  selectedToken = null;
  sel.image = sel.note = null;
  updateSelectionPanels();
  canvas.style.cursor = ""; // clear any frame-hover cursor
  controls.fogToggle?.classList.toggle("active", FOG_MODES.includes(nextMode));
  [controls.panMode, controls.polygonMode, controls.namedPolygonMode, controls.brushMode, controls.eraserMode, controls.stampMode, controls.tokenMode, controls.aoeMode, controls.measureMode, controls.stairMode, controls.drawMode, controls.lightMode].forEach(
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
    aoe: "Hover over the map to preview the area of effect. Mouse wheel rotates the cone.",
    measure: "Drag to measure distance across the grid.",
    stair: "Click to place a staircase. Right-click a stair to remove it.",
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
  drawingRoom = [];
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
  sel.image = sel.note = null;
  fogBuf.dirty = true;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshotFog());
  applyFogSnapshot(undoStack.pop());
  drawingRoom = [];
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



// --- Follow-camera easing -------------------------------------------------------------------------
// The follow camera glides toward followView()'s target instead of snapping to it: each frame the eased
// camera closes a fraction of the gap (center + zoom). An on-demand rAF loop runs while catching up and
// stops once settled, so there's no idle power cost. viewTransform reads playerCam.ease; the movement hooks
// (glide, drag, sync, toggle) call ensureCameraLoop() to (re)start it when the party moves.
function tickCamera() {
  camEaseRaf = 0;
  if (!isPlayer || !playerCam.follow) { playerCam.ease = null; return; }
  const rect = canvas.getBoundingClientRect();
  const v = activeView();
  const ms = state.map.scale || 1;
  const target = followView(rect, v, ms);
  if (!target) { playerCam.ease = null; return; }
  if (!playerCam.ease) playerCam.ease = { ...target }; // first frame after enable: snap to the party, then ease
  playerCam.ease.cx += (target.cx - playerCam.ease.cx) * CAM_EASE;
  playerCam.ease.cy += (target.cy - playerCam.ease.cy) * CAM_EASE;
  playerCam.ease.k += (target.k - playerCam.ease.k) * CAM_EASE;
  const arrived =
    Math.abs(target.cx - playerCam.ease.cx) < CAM_EASE_EPS &&
    Math.abs(target.cy - playerCam.ease.cy) < CAM_EASE_EPS &&
    Math.abs(target.k - playerCam.ease.k) < CAM_EASE_K_EPS;
  if (arrived) playerCam.ease = { ...target }; // settle exactly so it stops drifting
  render(); // draws through viewTransform, which reads playerCam.ease
  if (!arrived) camEaseRaf = requestAnimationFrame(tickCamera);
}

function ensureCameraLoop() {
  if (isPlayer && playerCam.follow && !camEaseRaf) camEaseRaf = requestAnimationFrame(tickCamera);
}

function stopCameraLoop() {
  if (camEaseRaf) { cancelAnimationFrame(camEaseRaf); camEaseRaf = 0; }
  playerCam.ease = null;
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

// GM "rotate map": rotates the GM view in 90° steps and carries the orientation to the
// player too (overriding any independent player rotation). All content rides the view
// transform, so fog, tokens and stairs rotate with the map.
function rotateMap(deg) {
  state.view.rotation = ((((state.view.rotation || 0) + deg) % 360) + 360) % 360;
  state.playerView.rotation = state.view.rotation; // authoritative — overrides the player setting
  if (state.playerView.matchDM) {
    state.playerView.scale = state.view.scale;
    state.playerView.cx = state.view.cx;
    state.playerView.cy = state.view.cy;
  }
  renderAndSync();
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
  const vw = playerViewport?.w || rect.width;
  const vh = playerViewport?.h || rect.height;
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

function render() {
  const rect = canvas.getBoundingClientRect();
  castFrameKeys.clear();
  lightFrameKeys.clear();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#080909";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (isPlayer && state.blackout) {
    emptyState.classList.add("hidden");
    return;
  }
  if (isPlayer && state.splash.enabled) {
    renderSplash(rect);
    return;
  }

  emptyState.classList.toggle("hidden", Boolean(state.imageData));
  if (!state.imageData || !mapImage.complete) return;

  const t = viewTransform();
  cur.k = t.k;
  cur.ms = t.ms;
  const { w, h } = worldDims();

  ctx.save();
  // Center the view, rotate, scale, then shift so (cx,cy) sits at the canvas center.
  ctx.translate(t.centerX, t.centerY);
  ctx.rotate(t.rot);
  ctx.scale(t.k, t.k);
  ctx.translate(-t.cx * t.ms, -t.cy * t.ms);

  // World block (native x map.scale)
  ctx.drawImage(mapImage, 0, 0, w, h);
  if (state.grid.enabled) drawGrid(w, h);

  // Native block
  ctx.save();
  ctx.scale(t.ms, t.ms);
  if (fogBuf.dirty) rebuildFog();
  // Images and tokens sit BELOW the fog so anything in an unrevealed area is hidden (solid
  // black for players, dimmed under the GM tint).
  drawImages();
  drawTokens();
  compositeFog();
  if (isPlayer && state.los.enabled) compositeLoS();
  drawAoeTemplate(); // hover template sits above fog; visible to both GM and player
  if (!isPlayer) drawRoomOutlines();
  if (!isPlayer) drawObstacleOutlines();
  if (!isPlayer) drawLights();
  if (!isPlayer) drawCastDebug();
  if (!isPlayer) drawStairs(); // stairs are a GM-only navigation aid stays above fog
  if (!isPlayer) drawDraftRoom();
  if (!isPlayer) drawDraftObstacle();
  if (!isPlayer) drawStampDraft();
  if (!isPlayer) drawCalibrationDraft();
  if (tools.measureLine) drawMeasureLine();
  if (!isPlayer && ["brush", "eraser"].includes(mode) && state.imageData) {
    drawToolPreview(screenToNative(clientToCanvasPoint(lastPointer)));
  }
  ctx.restore();

  ctx.restore();

  // Screen-space overlays
  drawPings();
  if (tools.measureLine) drawMeasureLabel();
  if (!isPlayer) drawRoomNames();
  if (!isPlayer) drawNotes();
  if (!isPlayer) drawPlayerFrame();
  if (isPlayer && playerMarquee) drawPlayerMarquee();

  // Keep the caches bounded to origins actually used this frame (~live token + light count).
  for (const k of castCache.keys()) if (!castFrameKeys.has(k)) castCache.delete(k);
  for (const k of lightCache.keys()) if (!lightFrameKeys.has(k)) lightCache.delete(k);
}

// GM-only: a red rectangle marking the region the player display currently shows, so the
// GM can tell exactly what their players see. Uses the player's reported pixel size.
// Screen-space corners of the player's visible region, or null when no frame is shown.
// Un-rotates by the player's own rotation, then projects through the GM transform, so the
// frame is correct even when the GM and player views are rotated differently.
function playerFrameCorners() {
  if (!showPlayerFrame || !playerViewport || !state.imageData) return null;
  const ms = state.map.scale || 1;
  const pv = state.playerView.matchDM ? state.view : state.playerView;
  if (!pv.scale) return null;
  const s = pv.scale * ms;
  const hw = playerViewport.w / 2;
  const hh = playerViewport.h / 2;
  const pr = ((pv.rotation || 0) * Math.PI) / 180;
  const cosP = Math.cos(-pr);
  const sinP = Math.sin(-pr);
  const toNative = (ox, oy) => ({
    x: pv.cx + (ox * cosP - oy * sinP) / s,
    y: pv.cy + (ox * sinP + oy * cosP) / s,
  });
  return [
    nativeToScreen(toNative(-hw, -hh)),
    nativeToScreen(toNative(hw, -hh)),
    nativeToScreen(toNative(hw, hh)),
    nativeToScreen(toNative(-hw, hh)),
  ];
}

function drawPlayerFrame() {
  const corners = playerFrameCorners();
  if (!corners) return;
  ctx.save();
  ctx.globalAlpha = playerFrameOpacity;
  ctx.strokeStyle = playerFrameColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function renderSplash(rect) {
  emptyState.classList.add("hidden");
  if (!state.splash.imageData || !splashImage.complete) {
    ctx.fillStyle = "#080909";
    ctx.fillRect(0, 0, rect.width, rect.height);
    return;
  }
  const scale = Math.min(rect.width / splashImage.naturalWidth, rect.height / splashImage.naturalHeight);
  const width = splashImage.naturalWidth * scale;
  const height = splashImage.naturalHeight * scale;
  ctx.drawImage(splashImage, (rect.width - width) / 2, (rect.height - height) / 2, width, height);
}

function drawGrid(worldW, worldH) {
  const size = state.grid.size;
  if (size <= 0) return;
  ctx.save();
  ctx.globalAlpha = state.grid.opacity;
  ctx.strokeStyle = state.grid.color;
  ctx.lineWidth = 1 / cur.k;
  ctx.beginPath();
  const startX = ((state.grid.offsetX % size) + size) % size;
  const startY = ((state.grid.offsetY % size) + size) % size;
  for (let x = startX; x <= worldW; x += size) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, worldH);
  }
  for (let y = startY; y <= worldH; y += size) {
    ctx.moveTo(0, y);
    ctx.lineTo(worldW, y);
  }
  ctx.stroke();
  ctx.restore();
}

/* ----------------------------- fog ----------------------------- */







function drawRoomOutlines() {
  ctx.save();
  state.fog.rooms.forEach((room) => {
    if (room.revealed) return;
    drawPolygon(room.points);
    ctx.strokeStyle = "rgba(214,169,77,0.72)";
    ctx.lineWidth = 2 / (cur.k * cur.ms);
    ctx.stroke();
  });
  ctx.restore();
}

const OBSTACLE_COLORS = {
  wall: "rgba(214,169,77,0.9)",
  object: "rgba(214,169,77,0.9)",
  door: "rgba(120,200,140,0.95)",
  window: "rgba(120,200,220,0.95)",
  invisible: "rgba(180,150,220,0.85)",
  ethereal: "rgba(190,190,190,0.75)",
};

// GM-only overlay of authored obstacle geometry ("Walls Visible to DM"). Points are in cells;
// convert to native to draw. Invisible obstacles render dashed (no in-world line).
function drawObstacleOutlines() {
  if (!showObstacles || !state.obstacles.length) return;
  ctx.save();
  ctx.lineWidth = 2.5 / (cur.k * cur.ms);
  ctx.lineJoin = "round";
  state.obstacles.forEach((ob) => {
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    if (pts.length < 2) return;
    const openDoor = ob.kind === "door" && ob.open;
    ctx.strokeStyle = openDoor ? "rgba(120,200,140,0.35)" : (OBSTACLE_COLORS[ob.kind] || OBSTACLE_COLORS.wall);
    ctx.setLineDash(ob.drawn === false || openDoor ? [9 / (cur.k * cur.ms), 6 / (cur.k * cur.ms)] : []);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.restore();
}

function drawDraftObstacle() {
  if (!drawingObstacle.length) return;
  ctx.save();
  ctx.strokeStyle = OBSTACLE_COLORS[obstacleKind] || OBSTACLE_COLORS.wall;
  ctx.lineWidth = 2.5 / (cur.k * cur.ms);
  ctx.lineJoin = "round";
  if (drawingObstacle.length > 1) {
    ctx.beginPath();
    ctx.moveTo(drawingObstacle[0].x, drawingObstacle[0].y);
    for (let i = 1; i < drawingObstacle.length; i++) ctx.lineTo(drawingObstacle[i].x, drawingObstacle[i].y);
    ctx.stroke();
  }
  drawingObstacle.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = OBSTACLE_COLORS[obstacleKind] || OBSTACLE_COLORS.wall;
    ctx.fill();
  });
  ctx.restore();
}


// Wrap text to maxW screen px (ctx.font must already be set). Hard-breaks words longer than
// the line, and caps at maxLines with an ellipsis so a long name never overflows its label.
function wrapLabel(text, maxW, maxLines) {
  const fits = (s) => ctx.measureText(s).width <= maxW;
  const lines = [];
  let line = "";
  for (let word of String(text).trim().split(/\s+/).filter(Boolean)) {
    while (!fits(word) && word.length > 1) {
      let cut = word.length;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const test = line ? line + " " + word : word;
    if (line && !fits(test)) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && !fits(last + "…")) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  return lines.length ? lines : [""];
}

// GM-only labels ("cartouches") for named fog areas. Drawn in screen space so they stay
// readable at any zoom; long names wrap (up to 3 lines) and truncate instead of overflowing.
// Players never call this, so the names are never shown on the player display.
function drawRoomNames() {
  const named = state.fog.rooms.filter((room) => room.name);
  if (!named.length) return;
  ctx.save();
  ctx.font = "600 13px Inter, ui-sans-serif, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = 200;
  const lh = 16;
  const padX = 7;
  const padY = 5;
  named.forEach((room) => {
    const screen = nativeToScreen(polygonCentroid(room.points));
    const lines = wrapLabel(room.name, maxW, 3);
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = Math.min(maxW, textW) + padX * 2;
    const boxH = lines.length * lh + padY * 2;
    const top = screen.y - boxH / 2;
    ctx.fillStyle = "rgba(8, 9, 9, 0.78)";
    ctx.fillRect(screen.x - boxW / 2, top, boxW, boxH);
    ctx.fillStyle = room.revealed ? "rgba(244, 232, 200, 0.5)" : "#f4e8c8";
    lines.forEach((line, i) => ctx.fillText(line, screen.x, top + padY + lh / 2 + i * lh));
  });
  ctx.restore();
}

function drawToolPreview(point) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = mode === "eraser" ? "rgba(214,106,95,0.95)" : "rgba(127,182,166,0.95)";
  ctx.fillStyle = mode === "eraser" ? "rgba(214,106,95,0.12)" : "rgba(127,182,166,0.12)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  drawToolShapePath(point, state.fog.toolSize, state.fog.toolShape);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawToolShapePath(point, size, shape) {
  const radius = size / 2;
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(point.x - radius, point.y - radius, size, size);
  } else {
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
}

function drawDraftRoom() {
  if (!drawingRoom.length) return;
  ctx.save();
  ctx.fillStyle = "rgba(127, 182, 166, 0.18)";
  ctx.strokeStyle = "rgba(127, 182, 166, 0.95)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  drawPolygon(drawingRoom);
  if (drawingRoom.length > 2) ctx.fill();
  ctx.stroke();
  drawingRoom.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = "#7fb6a6";
    ctx.fill();
  });
  ctx.restore();
}

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



// Derive a module's cell-space declaration (DTT-style) from its grid/measure calibration and its
// primary floor image, for record processing (splitState + the backfill) where there's no live
// state. pxPerCell is native px/cell = world cell size / mapScale; cellsX/Y are the image divided
// by that. Degrades to zeros when there's no grid and no calibration yet.
function deriveCellGrid(gridObj, measureObj, floor) {
  const cellWorld = gridObj.size > 0 ? gridObj.size : (measureObj && measureObj.cellSize > 0 ? measureObj.cellSize : 0);
  const mapScale = (floor && floor.mapScale) || 1;
  const pxPerCell = cellWorld > 0 ? cellWorld / mapScale : 0;
  const w = (floor && floor.imageWidth) || 0;
  const h = (floor && floor.imageHeight) || 0;
  return {
    pxPerCell,
    cellsX: pxPerCell > 0 ? Math.round(w / pxPerCell) : 0,
    cellsY: pxPerCell > 0 ? Math.round(h / pxPerCell) : 0,
    type: gridObj.type || "square",
    display: gridObj.display || "both",
  };
}


// Multi-cell tokens render as squares (they fill their grid footprint); single-cell
// tokens stay circular.
function tokenIsSquare(token) {
  return (token.cells || 1) > 1;
}

function tokenOutline(token, r) {
  if (tokenIsSquare(token)) {
    ctx.rect(token.x - r, token.y - r, r * 2, r * 2);
  } else {
    ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
  }
}

// Type -> ring color, so player / npc / monster read at a glance on the board.
const TOKEN_TYPE_RING = { player: "#3fb950", npc: "#539bf5", monster: "#e5534b" };

// A colored ring just outside a token's outline indicating its type. Drawn for every token
// on both the GM and player views. Tokens from before typing existed default to monster.
function drawTokenTypeRing(token, r) {
  const color = TOKEN_TYPE_RING[token.type] || TOKEN_TYPE_RING.monster;
  ctx.beginPath();
  tokenOutline(token, r + 1.5 / (cur.k * cur.ms));
  ctx.lineWidth = Math.max(1.5, 2.5 / (cur.k * cur.ms));
  ctx.strokeStyle = color;
  ctx.stroke();
}

// Draw a token's label centered in the token, auto-shrinking the font so the whole label
// fits inside the token (down to a floor), with a light outline so it stays legible over
// token art as well as flat color.
function drawTokenLabel(token, r, below) {
  const text = String(token.label);
  if (!text) return;
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  // Centered labels must fit inside the token; labels below have lateral room to breathe.
  const maxWidth = below ? r * 2.4 : r * 1.7;
  let fontPx = Math.round(gridCellNative() / 2);
  ctx.font = `700 ${fontPx}px Inter, sans-serif`;
  while (fontPx > 6 && ctx.measureText(text).width > maxWidth) {
    fontPx -= 1;
    ctx.font = `700 ${fontPx}px Inter, sans-serif`;
  }
  let y = token.y;
  if (below) {
    // Sit just under the type ring so the art stays clear and the name is readable.
    ctx.textBaseline = "top";
    y = token.y + r + 4 / (cur.k * cur.ms);
  } else {
    ctx.textBaseline = "middle";
  }
  ctx.lineWidth = Math.max(1, fontPx / 6);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(text, token.x, y);
  ctx.fillStyle = "#0c0d0d";
  ctx.fillText(text, token.x, y);
}

// Bright "whose turn it is" ring, drawn outermost on the active combatant's token on both
// the GM and player views. Static (no animation) to stay light on the off-grid power budget.
function drawActiveTurnRing(token, r) {
  ctx.beginPath();
  tokenOutline(token, r + 3.5 / (cur.k * cur.ms));
  ctx.lineWidth = Math.max(2, 4 / (cur.k * cur.ms));
  ctx.strokeStyle = "#ffd24a";
  ctx.stroke();
}

function drawTokens() {
  const lineW = Math.max(1, 2 / (cur.k * cur.ms));
  const rot = currentViewRotation();
  const activeTokenId = activeTurnTokenId();
  state.tokens.forEach((token) => {
    const r = tokenRadius(token);
    ctx.save();
    keepUpright(token.x, token.y, rot); // art + label stay upright when the map is rotated
    const img = getTokenImage(token.image);
    if (img && img.complete && img.naturalWidth) {
      // Token art: cover-fit the image into the token outline and ring it.
      ctx.save();
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.clip();
      const scale = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, token.x - w / 2, token.y - h / 2, w, h);
      ctx.restore();
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.lineWidth = lineW;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();
      if (token.label) drawTokenLabel(token, r, true);
    } else {
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.fillStyle = token.color || "#d6a94d";
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = lineW;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();
      if (token.label) drawTokenLabel(token, r, false);
    }
    drawTokenTypeRing(token, r);
    // Selection highlight (GM only): an accent outline around the active token.
    if (!isPlayer && token === selectedToken) {
      ctx.beginPath();
      tokenOutline(token, r + 3 / (cur.k * cur.ms));
      ctx.lineWidth = Math.max(1.5, 3 / (cur.k * cur.ms));
      ctx.strokeStyle = "#b1c301";
      ctx.stroke();
    }
    // Selection highlight (player screen): a cyan outline on every selected token — the targets of
    // arrow-key movement.
    if (isPlayer && selectedPlayerTokens.includes(token)) {
      ctx.beginPath();
      tokenOutline(token, r + 3 / (cur.k * cur.ms));
      ctx.lineWidth = Math.max(1.5, 3 / (cur.k * cur.ms));
      ctx.strokeStyle = "#3ad2e6";
      ctx.stroke();
    }
    if (token.id === activeTokenId) drawActiveTurnRing(token, r);
    ctx.restore();
  });
}

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
      if (selectedToken) {
        pushHistory();
        selectedToken.image = tokenImageData;
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
  if (selectedToken && selectedToken.image) {
    pushHistory();
    selectedToken.image = "";
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
  if (!selectedToken) return;
  const step = gridCellNative();
  const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  if (!delta) return;
  pushHistory();
  selectedToken.x += delta[0] * step;
  selectedToken.y += delta[1] * step;
  const snapped = snapNative(selectedToken);
  selectedToken.x = snapped.x;
  selectedToken.y = snapped.y;
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
// cell (no wall stopping it short) AND land on a cell free of any non-group token, or the entire
// formation holds. Because the group moves by one uniform vector it can never collide with itself, so
// occupancy is only tested against non-group tokens. Grabs lazily on the first step that actually
// moves, so holding the party into a wall never creates an empty undo step. Returns true if it moved.
function glideStepOnce() {
  if (!glideKey || !selectedPlayerTokens.length) return false;
  const delta = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[glideKey];
  if (!delta) return false;
  const step = gridCellNative();
  const group = new Set(selectedPlayerTokens);
  const planned = [];
  for (const token of selectedPlayerTokens) {
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
  if (!selectedPlayerTokens.length) return;
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
  if (!glideKey || !selectedPlayerTokens.length) { stopGlide(true); return; }
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
      for (const token of selectedPlayerTokens) {
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
  const m = playerMarquee;
  if (!m) return;
  const minX = Math.min(m.x0, m.x1), maxX = Math.max(m.x0, m.x1);
  const minY = Math.min(m.y0, m.y1), maxY = Math.max(m.y0, m.y1);
  const dragged = maxX - minX > 4 || maxY - minY > 4;
  if (!dragged) {
    if (!m.additive) { selectedPlayerTokens = []; render(); } // empty-space tap clears
    return;
  }
  const inBox = state.tokens.filter((t) => {
    if (t.type !== "player") return false;
    const s = nativeToScreen({ x: t.x, y: t.y });
    return s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
  });
  if (m.additive) {
    const set = new Set(selectedPlayerTokens);
    inBox.forEach((t) => set.add(t));
    selectedPlayerTokens = [...set];
  } else {
    selectedPlayerTokens = inBox;
  }
  render();
}

// Draw the rubber-band box in screen space (canvas px), matching the cyan selection accent.
function drawPlayerMarquee() {
  const m = playerMarquee;
  if (!m) return;
  const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  ctx.save();
  ctx.fillStyle = "rgba(58,210,230,0.12)";
  ctx.strokeStyle = "#3ad2e6";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
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
      selectedToken = sel.note = null;
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
  selectedToken = sel.image = null;
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

// Show/populate the View-section panels for the currently selected image or note.
function updateSelectionPanels() {
  if (isPlayer) return;
  if (controls.tokenSelPanel) {
    controls.tokenSelPanel.classList.toggle("hidden", !selectedToken);
    if (selectedToken) {
      if (controls.tokenSelType) controls.tokenSelType.value = selectedToken.type || "monster";
      if (controls.tokenSelLabel) controls.tokenSelLabel.value = selectedToken.label || "";
      if (controls.tokenSelColor) controls.tokenSelColor.value = selectedToken.color || "#d6a94d";
      if (controls.tokenSelCells) controls.tokenSelCells.value = selectedToken.cells || 1;
      if (controls.tokenSelLight) controls.tokenSelLight.value = selectedToken.light || 0;
      if (controls.tokenSelLightVal) controls.tokenSelLightVal.textContent = selectedToken.light || 0;
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
}

function deleteTokenOrRoom(native) {
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
    if (token === selectedToken) selectedToken = null;
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
    broadcastState();
  }
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
  lastPointer = { clientX: event.clientX, clientY: event.clientY };

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
        selectedPlayerTokens = selectedPlayerTokens.includes(hit)
          ? selectedPlayerTokens.filter((t) => t !== hit)
          : [...selectedPlayerTokens, hit];
        render();
      } else {
        // Grab a token to drag. Grabbing a token that's ALREADY in the selection keeps the whole
        // group and drags the formation together; grabbing one that's NOT selected replaces the
        // selection with just it. A no-move tap on a member leaves the group intact (lazy grab).
        if (!selectedPlayerTokens.includes(hit)) selectedPlayerTokens = [hit];
        draggingToken = hit; // the anchor the pointer follows
        groupDragOffsets = selectedPlayerTokens.map((t) => ({ token: t, dx: t.x - hit.x, dy: t.y - hit.y }));
        dragGrabbed = false; // grab lazily on the first cell that actually moves
        isDragging = true;
        capturePointer(event.pointerId);
        render();
      }
    } else {
      // Empty space starts a marquee. Shift keeps the current selection and adds the box; without
      // shift the box replaces the selection (and a no-drag tap clears it — handled on pointer-up).
      const p = clientToCanvasPoint(event);
      playerMarquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: event.shiftKey };
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

  if (mode === "stamp") {
    fogBuf.stampDraft = { shape: state.fog.stampShape, start: native, end: native };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    return;
  }

  if (mode === "aoe") {
    return; // hover-only: no click/drag action
  }

  if (mode === "polygon" || mode === "namedPolygon") {
    drawingRoom.push(native);
    render();
    return;
  }

  if (mode === "draw") {
    drawingObstacle.push(native);
    render();
    return;
  }

  if (mode === "light") {
    addLight(native);
    return;
  }

  if (mode === "token") {
    const hit = hitToken(native);
    if (hit) {
      pushHistory();
      draggingToken = hit;
      isDragging = true;
      capturePointer(event.pointerId);
    } else {
      addToken(native);
    }
    return;
  }

  if (mode === "stair") {
    if (state.floors.length < 2) {
      window.alert("Add a second floor first.");
      return;
    }
    promptStairPlacement(native);
    return;
  }

  // In Move mode: click a token to select it (for arrow-key nudging), a note or image to
  // select+drag it, or a stair to jump floors. Clicking empty space clears selection and pans.
  if (mode === "pan") {
    const token = hitToken(native);
    if (token) {
      // Select it (edit panel + arrow-key nudge) AND start a drag, so a click-drag moves the
      // token like every other VTT; a plain click with no movement just selects + snaps in place.
      pushHistory();
      selectedToken = token;
      sel.image = sel.note = null;
      draggingToken = token;
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
      selectedToken = sel.image = null;
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
      selectedToken = sel.note = null;
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
    if (selectedToken || sel.image || sel.note) {
      selectedToken = sel.image = sel.note = null;
      updateSelectionPanels();
      render();
    }
  }

  if (mode === "measure") {
    tools.measureLine = { start: native, end: native };
    isDragging = true;
    capturePointer(event.pointerId);
    render();
    relay({ type: "measure", line: tools.measureLine });
    return;
  }

  if (mode === "brush" || mode === "eraser") {
    pushHistory();
    fogBuf.activeStroke = {
      id: uuid(),
      kind: mode === "eraser" ? "erase" : "paint",
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
  lastPointer = { clientX: event.clientX, clientY: event.clientY };

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
        if (!dragGrabbed) {
          dragGrabbed = true;
          relay({ type: "token-grab", id: draggingToken.id }); // one history snapshot for the drag
        }
        render();
        streamGroupMove();
        ensureCameraLoop(); // glide the follow camera as the party is dragged
      }
    } else if (playerMarquee) {
      const p = clientToCanvasPoint(event);
      playerMarquee.x1 = p.x;
      playerMarquee.y1 = p.y;
      render();
    }
    return;
  }

  if (!isDragging) {
    if (["brush", "eraser"].includes(mode)) render(); // live tool preview
    if (mode === "aoe" && state.imageData) {
      const native = toNativePoint(event);
      tools.aoe.template.x = native.x;
      tools.aoe.template.y = native.y;
      tools.aoe.template.visible = true;
      renderAndSyncView();
    }
    // Hint that the player-view frame can be dragged.
    if (mode === "pan" && state.imageData) {
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
    } else if (playerMarquee) {
      finishPlayerMarquee();
      playerMarquee = null;
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

  if (draggingFrame) {
    draggingFrame = false;
    renderAndSync(); // persist the player view position
  }

  if (tools.measureLine && mode === "measure") {
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
  if (mode === "aoe" && tools.aoe.shape === "cone") {
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
  if (mode === "polygon" || mode === "namedPolygon") finishRoom();
  if (mode === "draw") finishObstacle();
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
  if (mode === "draw") {
    const ob = hitObstacle(toNativePoint(event));
    if (ob) {
      pushHistory();
      state.obstacles = state.obstacles.filter((o) => o !== ob);
      invalidateCast();
      renderAndSync();
    }
    return;
  }
  if (mode === "light") {
    const lt = hitLight(toNativePoint(event));
    if (lt) {
      pushHistory();
      state.lights = state.lights.filter((l) => l !== lt);
      invalidateCast();
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
    // Arrow keys walk the selected player token(s). First press steps instantly; holding marches at
    // PLAYER_MOVE_CELLS_PER_SEC via the rAF movement clock. One token-grab + one drop-per-token per march.
    if (selectedPlayerTokens.length && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
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

  const drawingPolygon = mode === "polygon" || mode === "namedPolygon";
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === "z") {
    event.preventDefault();
    // While placing a polygon, Ctrl+Z removes just the last point you dropped,
    // so a single misclick doesn't scrap the whole shape (or earlier committed work).
    if (!event.shiftKey && drawingPolygon && drawingRoom.length) {
      drawingRoom.pop();
      render();
      return;
    }
    if (!event.shiftKey && mode === "draw" && drawingObstacle.length) {
      drawingObstacle.pop();
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
  if ((event.key === "Backspace" || event.key === "Delete") && drawingPolygon && drawingRoom.length) {
    event.preventDefault();
    drawingRoom.pop();
    render();
    return;
  }
  if ((event.key === "Backspace" || event.key === "Delete") && mode === "draw" && drawingObstacle.length) {
    event.preventDefault();
    drawingObstacle.pop();
    render();
    return;
  }

  // A selected token (Move mode) nudges one grid cell per arrow press, snapped to grid.
  if (selectedToken && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    nudgeSelectedToken(event.key);
    return;
  }
  if (selectedToken && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    pushHistory();
    const removedTokenId = selectedToken.id;
    state.tokens = state.tokens.filter((t) => t !== selectedToken);
    selectedToken = null;
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
  if (event.key === "Enter" && mode === "draw") {
    event.preventDefault();
    finishObstacle();
    return;
  }
  if (event.key === "Escape" && drawingPolygon && drawingRoom.length) {
    event.preventDefault();
    drawingRoom = [];
    render();
    return;
  }
  if (event.key === "Escape" && mode === "draw" && drawingObstacle.length) {
    event.preventDefault();
    drawingObstacle = [];
    render();
    return;
  }

  const shortcuts = { v: "pan", h: "pan", p: "polygon", n: "namedPolygon", b: "brush", e: "eraser", t: "token", a: "aoe", m: "measure", s: "stair", d: "draw", l: "light" };
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
  if (!["brush", "eraser"].includes(mode)) return;
  const next = Math.min(Number(controls.brushSize.max), Math.max(Number(controls.brushSize.min), state.fog.toolSize + delta));
  state.fog.toolSize = next;
  controls.brushSize.value = next;
  render();
}

// ----- Obstacle geometry (Draw Mode) -----

// Closed-state behavior flags per kind. Doors block until opened (the session tracks open doors);
// windows are see-through but block movement; invisible walls block sight/light but draw no line.
function obstacleDefaults(kind) {
  switch (kind) {
    case "window":    return { blocksSight: false, blocksLight: false, blocksMove: true, drawn: true, openable: false };
    case "door":      return { blocksSight: true, blocksLight: true, blocksMove: true, drawn: true, openable: true };
    case "invisible": return { blocksSight: true, blocksLight: true, blocksMove: true, drawn: false, openable: false };
    default:          return { blocksSight: true, blocksLight: true, blocksMove: true, drawn: true, openable: false }; // wall/object/ethereal
  }
}

// Commit the in-progress polyline as an obstacle of the current kind. Points convert to cell units
// (the step-3 bridge) so geometry is resolution-independent and DTT-import-compatible.
function finishObstacle() {
  if (isPlayer || drawingObstacle.length < 2) return;
  pushHistory();
  const obstacle = {
    id: uuid(),
    kind: obstacleKind,
    points: drawingObstacle.map((p) => [p.x, p.y]),
    ...obstacleDefaults(obstacleKind),
    defaultOpen: false,
  };
  state.obstacles.push(obstacle);
  invalidateCast();
  drawingObstacle = [];
  renderAndSync();
}


// The obstacle nearest a native click within a small threshold, or null. Stored points are in
// cells, so convert to native before measuring.
function hitObstacle(native) {
  const threshold = Math.max(10, gridCellNative() / 3);
  let best = null;
  let bestDist = threshold;
  state.obstacles.forEach((ob) => {
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(native, pts[i], pts[i + 1]);
      if (d < bestDist) { bestDist = d; best = ob; }
    }
  });
  return best;
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
let moveSegCache = null;
let moveSegVersion = -1;
function moveSegments() {
  if (moveSegCache && moveSegVersion === castVersion) return moveSegCache;
  const segs = [];
  state.obstacles.forEach((ob) => {
    if (ob.blocksMove === false) return;
    if (ob.kind === "door" && ob.open) return; // open doors let movement through
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
  });
  const w = state.imageWidth || 0;
  const h = state.imageHeight || 0;
  segs.push({ a: { x: 0, y: 0 }, b: { x: w, y: 0 } });
  segs.push({ a: { x: w, y: 0 }, b: { x: w, y: h } });
  segs.push({ a: { x: w, y: h }, b: { x: 0, y: h } });
  segs.push({ a: { x: 0, y: h }, b: { x: 0, y: 0 } });
  moveSegCache = segs;
  moveSegVersion = castVersion;
  return segs;
}

// Nearest wall the move (origin -> origin+move) crosses, as { t, seg } where t is the fraction
// along `move` (rayHit returns origin + move*t); null if the whole move is clear.
function firstMoveHit(origin, move, segs) {
  let best = 1, hitSeg = null;
  for (const seg of segs) {
    const h = rayHit(origin, move, seg);
    if (h && h.t < best) { best = h.t; hitSeg = seg; }
  }
  return hitSeg ? { t: best, seg: hitSeg } : null;
}

// Resolve a token move from -> to against move-blocking walls: stop just short of the first wall
// crossed, then slide the leftover motion along that wall (one pass, so a perpendicular wall still
// stops the slide). Center-path — the token is a point at its center; radius is a future chunk.
function resolveMove(from, to) {
  const move = { x: to.x - from.x, y: to.y - from.y };
  const len = Math.hypot(move.x, move.y);
  if (len < 1e-9) return { x: to.x, y: to.y };
  const segs = moveSegments();
  const hit = firstMoveHit(from, move, segs);
  if (!hit) return { x: to.x, y: to.y }; // clear path
  const back = Math.max(0, hit.t - 0.5 / len); // rest ~0.5px off the wall
  const contact = { x: from.x + move.x * back, y: from.y + move.y * back };
  // Slide: project the leftover motion onto the wall's direction, then sweep that too.
  const rem = { x: move.x * (1 - hit.t), y: move.y * (1 - hit.t) };
  const wx = hit.seg.b.x - hit.seg.a.x, wy = hit.seg.b.y - hit.seg.a.y;
  const wlen = Math.hypot(wx, wy);
  if (wlen < 1e-9) return contact;
  const ux = wx / wlen, uy = wy / wlen;
  const d = rem.x * ux + rem.y * uy;
  const slide = { x: ux * d, y: uy * d };
  const slen = Math.hypot(slide.x, slide.y);
  if (slen < 1e-9) return contact;
  const sHit = firstMoveHit(contact, slide, segs);
  if (!sHit) return { x: contact.x + slide.x, y: contact.y + slide.y };
  const sBack = Math.max(0, sHit.t - 0.5 / slen);
  return { x: contact.x + slide.x * sBack, y: contact.y + slide.y * sBack };
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
  state.lights.push({ id: uuid(), x: native.x, y: native.y, radius: tools.lightRadius * pxPerCellNative() });
  invalidateCast();
  renderAndSync();
}




// Wipe explored memory for the current floor (the player's "Reset explored"). GM relays this to
// the player window, where the actual memory lives.
function resetExplored() {
  exploredMasks.delete(state.currentFloorId);
}


// GM-only debug overlay: when castDebug is on and a token is selected, fill + outline the
// visibility polygon cast from that token so the engine can be eyeballed (walls occlude,
// windows pass, corners peek) before any consumer is wired up. Drawn in the Native block.
function drawCastDebug() {
  if (isPlayer || !castDebug || !selectedToken || !state.imageData) return;
  const poly = getVisibilityPolygon({ x: selectedToken.x, y: selectedToken.y });
  if (poly.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(120, 220, 255, 0.16)";
  ctx.fill();
  ctx.lineWidth = 1.5 / (cur.k * cur.ms);
  ctx.strokeStyle = "rgba(120, 220, 255, 0.85)";
  ctx.stroke();
  // Mark the cast origin.
  ctx.beginPath();
  ctx.arc(selectedToken.x, selectedToken.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(120, 220, 255, 0.95)";
  ctx.fill();
  ctx.restore();
}

function finishRoom() {
  if (isPlayer || drawingRoom.length < 3) return;
  pushHistory();
  const room = {
    id: uuid(),
    points: drawingRoom.map((point) => ({ ...point })),
    revealed: false,
    name: "",
  };
  state.fog.rooms.push(room);
  drawingRoom = [];
  fogBuf.dirty = true;
  renderAndSync();
  if (mode === "namedPolygon") {
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
  mapImage = new Image();
  mapImage.onload = afterLoad;
  mapImage.src = src;
}

function loadSplashImage(src, afterLoad) {
  splashImage = new Image();
  splashImage.onload = afterLoad;
  splashImage.src = src;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}


setup();
