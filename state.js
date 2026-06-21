/* state.js — shared hub for vwag-table.
 * Owns the data every module reads/mutates: the `state` object, the offscreen canvases,
 * the runtime caches, the `controls` DOM map, the app constants, and the pure utilities.
 * Everything here is either immutable or MUTATED (never reassigned across a module
 * boundary), so it survives ES-module live-binding rules. Modules import from here; nothing
 * here imports back. (Module-level `let`s that get reassigned still live with their code
 * and travel into their own modules as the split proceeds.)
 */

const canvas = document.getElementById("battlemap");
const ctx = canvas.getContext("2d");
// Fog is composited from two independent layers so erasing freeform fog can never get
// "stuck": polyCanvas holds the polygon/stamp areas, strokeCanvas holds the freeform
// brush/bucket layer (its own erases baked in chronologically), and fogCanvas is their
// union (what's drawn). liveCanvas previews the in-progress brush stroke.
const fogCanvas = document.createElement("canvas");
const fogCtx = fogCanvas.getContext("2d");
const liveCanvas = document.createElement("canvas");
const liveCtx = liveCanvas.getContext("2d");
const polyCanvas = document.createElement("canvas");
const polyCtx = polyCanvas.getContext("2d");
const strokeCanvas = document.createElement("canvas");
const strokeCtx = strokeCanvas.getContext("2d");
// Line-of-sight mask (step 5b): black everywhere the players' tokens can't currently see,
// cut out with the cast visibility polygons, composited over the player view only.
const losCanvas = document.createElement("canvas");
const losCtx = losCanvas.getContext("2d");
// 5c: the darkness overlay actually drawn to the player view (unexplored black, explored dim,
// visible clear), and a per-floor accumulating record of everywhere the party has ever seen.
// exploredMasks is runtime-only (it resets on reload) and keyed by floor id.
const darkCanvas = document.createElement("canvas");
const darkCtx = darkCanvas.getContext("2d");
// 5d: light coverage for the current frame (union of every placed light, wall-occluded and
// radius-clipped). When darkness is on, the player only sees line-of-sight INTERSECT this.
const lightCanvas = document.createElement("canvas");
const lightCtx = lightCanvas.getContext("2d");
const exploredMasks = new Map(); // floorId -> offscreen canvas at fog-buffer resolution
const lightCache = new Map(); // "version|lx|ly|radius" -> light visibility polygon (cleared on invalidateCast)
const shell = document.querySelector(".app-shell");
const emptyState = document.getElementById("emptyState");
const channel = new BroadcastChannel("fog-table-state");
const APP_NAME = "Battlemap Screen and GM Streaming Tool";
const LEGACY_APP_NAME = "Fog Table";
const SAVE_FILE_VERSION = 11;
const DB_NAME = "fog-table-library";
const DB_VERSION = 4;
const MAP_STORE = "maps";
const IMAGE_STORE = "images";
const MODULE_STORE = "modules";
const SESSION_STORE = "sessions";
const TOKEN_STORE = "tokens";
const FOG_MAX_EDGE = 4096; // cap fog raster resolution so huge maps stay within canvas/memory limits
const HISTORY_LIMIT = 80;

// Tabler stair icons (24×24), copied verbatim from tabler.io.
// NEUTRAL = tabler/stairs · UP = tabler/stairs-up · DOWN = tabler/stairs-down.
const STAIRS_ICON_NEUTRAL = new Path2D("M22 5h-5v5h-5v5h-5v5h-5");
const STAIRS_ICON_UP = new Path2D("M22 6h-5v5h-5v5h-5v5h-5 M6 10v-7 M3 6l3 -3l3 3");
const STAIRS_ICON_DOWN = new Path2D("M22 21h-5v-5h-5v-5h-5v-5h-5 M18 3v7 M15 7l3 3l3 -3");
const FEET_PER_CELL = 5;
// Real-world distance one grid cell represents, per measurement system.
const MEASURE_UNITS = {
  imperial: { perCell: 5, label: "ft" },
  metric: { perCell: 1.5, label: "m" },
};
const PING_DURATION = 1300;

const controls = {
  mapUpload: document.getElementById("mapUpload"),
  dttUpload: document.getElementById("dttUpload"),
  splashUpload: document.getElementById("splashUpload"),
  splashEnabled: document.getElementById("splashEnabled"),
  blackoutEnabled: document.getElementById("blackoutEnabled"),
  losEnabled: document.getElementById("losEnabled"),
  losOptions: document.getElementById("losOptions"),
  loadLibrary: document.getElementById("loadLibrary"),
  saveSession: document.getElementById("saveSession"),
  openPlayer: document.getElementById("openPlayer"),
  exportLibrary: document.getElementById("exportLibrary"),
  importLibrary: document.getElementById("importLibrary"),
  gridEnabled: document.getElementById("gridEnabled"),
  gridSnap: document.getElementById("gridSnap"),
  gridSize: document.getElementById("gridSize"),
  gridOffsetX: document.getElementById("gridOffsetX"),
  gridOffsetY: document.getElementById("gridOffsetY"),
  gridColor: document.getElementById("gridColor"),
  gridOpacity: document.getElementById("gridOpacity"),
  mapScale: document.getElementById("mapScale"),
  brushSize: document.getElementById("brushSize"),
  fogTint: document.getElementById("fogTint"),
  gmFogOpacity: document.getElementById("gmFogOpacity"),
  losBrightness: document.getElementById("losBrightness"),
  resetExplored: document.getElementById("resetExplored"),
  tokenColor: document.getElementById("tokenColor"),
  tokenCells: document.getElementById("tokenCells"),
  tokenLabel: document.getElementById("tokenLabel"),
  tokenType: document.getElementById("tokenType"),
  tokenLight: document.getElementById("tokenLight"),
  paletteGrid: document.getElementById("paletteGrid"),
  paletteAdd: document.getElementById("paletteAdd"),
  paletteSize: document.getElementById("paletteSize"),
  paletteImport: document.getElementById("paletteImport"),
  paletteFolder: document.getElementById("paletteFolder"),
  paletteExport: document.getElementById("paletteExport"),
  paletteJson: document.getElementById("paletteJson"),
  paletteSelected: document.getElementById("paletteSelected"),
  paletteSelectedName: document.getElementById("paletteSelectedName"),
  paletteDelete: document.getElementById("paletteDelete"),
  tokenLightVal: document.getElementById("tokenLightVal"),
  tokenSelPanel: document.getElementById("tokenSelPanel"),
  tokenSelType: document.getElementById("tokenSelType"),
  tokenSelLabel: document.getElementById("tokenSelLabel"),
  tokenSelColor: document.getElementById("tokenSelColor"),
  tokenSelCells: document.getElementById("tokenSelCells"),
  tokenSelLight: document.getElementById("tokenSelLight"),
  tokenSelLightVal: document.getElementById("tokenSelLightVal"),
  tokenImage: document.getElementById("tokenImage"),
  tokenImagePreview: document.getElementById("tokenImagePreview"),
  tokenImageClear: document.getElementById("tokenImageClear"),
  panMode: document.getElementById("panMode"),
  fogToggle: document.getElementById("fogToggle"),
  fogRibbon: document.getElementById("fogRibbon"),
  polygonMode: document.getElementById("polygonMode"),
  namedPolygonMode: document.getElementById("namedPolygonMode"),
  brushMode: document.getElementById("brushMode"),
  eraserMode: document.getElementById("eraserMode"),
  stampMode: document.getElementById("stampMode"),
  tokenMode: document.getElementById("tokenMode"),
  aoeMode: document.getElementById("aoeMode"),
  aoeOptions: document.getElementById("aoeOptions"),
  aoeCircle: document.getElementById("aoeCircle"),
  aoeSquare: document.getElementById("aoeSquare"),
  aoeCone: document.getElementById("aoeCone"),
  aoeColor: document.getElementById("aoeColor"),
  aoePresetsRow: document.getElementById("aoePresetsRow"),
  aoeCustomSize: document.getElementById("aoeCustomSize"),
  aoeAngleSlider: document.getElementById("aoeAngleSlider"),
  aoeAngleRow: document.getElementById("aoeAngleRow"),
  measureMode: document.getElementById("measureMode"),
  measureOptions: document.getElementById("measureOptions"),
  measureUnit: document.getElementById("measureUnit"),
  measureCalibrate: document.getElementById("measureCalibrate"),
  measureCalibrateRow: document.getElementById("measureCalibrateRow"),
  gridCalibrate: document.getElementById("gridCalibrate"),
  roundShape: document.getElementById("roundShape"),
  squareShape: document.getElementById("squareShape"),
  brushSizeRow: document.getElementById("brushSizeRow"),
  brushShapeRow: document.getElementById("brushShapeRow"),
  stampShapeRow: document.getElementById("stampShapeRow"),
  fogToolHeading: document.getElementById("fogToolHeading"),
  stampRect: document.getElementById("stampRect"),
  stampSquare: document.getElementById("stampSquare"),
  stampEllipse: document.getElementById("stampEllipse"),
  stampCircle: document.getElementById("stampCircle"),
  stampTriangle: document.getElementById("stampTriangle"),
  clearFog: document.getElementById("clearFog"),
  bucketFill: document.getElementById("bucketFill"),
  undo: document.getElementById("undoBtn"),
  redo: document.getElementById("redoBtn"),
  brushOptions: document.getElementById("brushOptions"),
  tokenOptions: document.getElementById("tokenOptions"),
  tokenPalette: document.getElementById("tokenPalette"),
  drawOptions: document.getElementById("drawOptions"),
  drawMode: document.getElementById("drawMode"),
  lightMode: document.getElementById("lightMode"),
  lightOptions: document.getElementById("lightOptions"),
  lightRadius: document.getElementById("lightRadius"),
  lightRadiusVal: document.getElementById("lightRadiusVal"),
  darknessEnabled: document.getElementById("darknessEnabled"),
  obstacleKind: document.getElementById("obstacleKind"),
  showObstacles: document.getElementById("showObstacles"),
  castDebug: document.getElementById("castDebug"),
  fitMap: document.getElementById("fitMap"),
  playerMatchDM: document.getElementById("playerMatchDM"),
  playerFrameToggle: document.getElementById("playerFrameToggle"),
  rotateMapLeft: document.getElementById("rotateMapLeft"),
  rotateMapRight: document.getElementById("rotateMapRight"),
  rotatePlayerLeft: document.getElementById("rotatePlayerLeft"),
  rotatePlayerRight: document.getElementById("rotatePlayerRight"),
  playerFit: document.getElementById("playerFit"),
  lockPlayerSquare: document.getElementById("lockPlayerSquare"),
  stairColor: document.getElementById("stairColor"),
  addImageInput: document.getElementById("addImageInput"),
  addNoteBtn: document.getElementById("addNoteBtn"),
  imageSnap: document.getElementById("imageSnap"),
  imageSelPanel: document.getElementById("imageSelPanel"),
  imageShowPlayers: document.getElementById("imageShowPlayers"),
  imageSize: document.getElementById("imageSize"),
  imageRotation: document.getElementById("imageRotation"),
  noteSelPanel: document.getElementById("noteSelPanel"),
  noteSize: document.getElementById("noteSize"),
  playerFrameColor: document.getElementById("playerFrameColor"),
  playerFrameOpacity: document.getElementById("playerFrameOpacity"),
  panelToggle: document.getElementById("panelToggle"),
  copyDMView: document.getElementById("copyDMView"),
  playerZoom: document.getElementById("playerZoom"),
  playerOffsetX: document.getElementById("playerOffsetX"),
  playerOffsetY: document.getElementById("playerOffsetY"),
  modeHint: document.getElementById("modeHint"),
  playerFullscreen: document.getElementById("playerFullscreen"),
  libraryDialog: document.getElementById("libraryDialog"),
  savedMapList: document.getElementById("savedMapList"),
  nameDialog: document.getElementById("nameDialog"),
  roomNameInput: document.getElementById("roomNameInput"),
  stairMode: document.getElementById("stairMode"),
  stairDialog: document.getElementById("stairDialog"),
  stairFloorSelect: document.getElementById("stairFloorSelect"),
  stairLabelInput: document.getElementById("stairLabelInput"),
  floorIndicator: document.getElementById("floorIndicator"),
  floorName: document.getElementById("floorName"),
  floorUp: document.getElementById("floorUp"),
  floorDown: document.getElementById("floorDown"),
  addFloorUp: document.getElementById("addFloorUp"),
  addFloorDown: document.getElementById("addFloorDown"),
  deleteFloor: document.getElementById("deleteFloor"),
  playerFloorBadge: document.getElementById("playerFloorBadge"),
  fitMapBtn: document.getElementById("fitMapBtn"),
  initToggle: document.getElementById("initToggle"),
  initiativePanel: document.getElementById("initiativePanel"),
  initiativeOverlay: document.getElementById("initiativeOverlay"),
  initShowPlayers: document.getElementById("initShowPlayers"),
  initShowOverlay: document.getElementById("initShowOverlay"),
  initClose: document.getElementById("initClose"),
  initPrev: document.getElementById("initPrev"),
  initNext: document.getElementById("initNext"),
  initReset: document.getElementById("initReset"),
  initRoundLabel: document.getElementById("initRoundLabel"),
  initList: document.getElementById("initList"),
  initAddForm: document.getElementById("initAddForm"),
  initAddTokens: document.getElementById("initAddTokens"),
  initName: document.getElementById("initName"),
  initRoll: document.getElementById("initRoll"),
  initHp: document.getElementById("initHp"),
  initType: document.getElementById("initType"),
};

const isPlayer = new URLSearchParams(window.location.search).get("view") === "player";
const DEFAULT_GM_FOG_OPACITY = 0.3;
const INITIAL_FLOOR_ID = "floor-1";

// Ephemeral player-screen follow-camera flags — deliberately NOT part of `state`, so they're never
// synced to the GM or saved to the DB. They live in the hub only so the read side (geometry.js's
// viewTransform/followView) and the write side (the view actions in app.js / later view.js) share one
// object across module boundaries. Mutated in place, never reassigned, so live bindings are safe.
const playerCam = { follow: false, fitZoom: false, ease: null };

// Active drawing-tool state, shared between the input/sync handlers (which write it) and the
// aoe-measure draw functions (which read it). The `aoe` sub-object is mirrored window-to-window by
// the sync handlers exactly as the old bare lets were; `measureLine` and the calibration fields are
// local to each window. Mutated in place, never reassigned. NOT part of the saved `state` document.
const tools = {
  aoe: { shape: "circle", color: "#e2603a", sizeFt: 10, angle: -Math.PI / 2, template: { visible: false, x: 0, y: 0 } },
  measureLine: null,
  calibrating: null,
  calibrationDraft: null,
  lightRadius: 3, // radius (cells) applied to newly placed lights — small=torch, large=firepit
  drawingRoom: [], // in-progress room polyline (native px) while drawing in Draw Mode
  drawingObstacle: [], // in-progress obstacle polyline (native px) while drawing in Draw Mode
  showObstacles: true, // GM-only obstacle overlay toggle ("Walls Visible to DM")
  obstacleKind: "wall", // kind applied to newly drawn obstacles
};

// Last-rendered transform scale, cached by render() and read by every draw function so overlays and
// markers keep a constant on-screen width regardless of zoom. cur.k = screen px per world px,
// cur.ms = map.scale. Ephemeral render cache; not part of the saved `state` document.
const cur = { k: 1, ms: 1 };

// Orchestration hooks — wired once at startup (app.js) so feature modules can trigger a redraw, a
// redraw+sync, or a relay without importing the render/sync layer (which is split out last, step 14).
const hooks = { render: () => {}, renderAndSync: () => {}, relay: () => {} };

// GM Move-mode selection of non-token objects, read by the annotation draws (to ring the selected
// item) and written by the Move-mode handlers. Ephemeral; not part of the saved `state` document.
const sel = { image: null, note: null, token: null, playerTokens: [] };
// Handle to the popped-out player window (GM side); the player side reaches the GM via window.opener.
// Mutated when the popup opens or a message identifies its source. Never rebound across modules.
const peerWindow = { ref: null };
// Cast/light visibility caches (promoted from app.js): the cast-polygon cache keyed by version+origin,
// and the per-frame key sets render() prunes against. Mutated by vision.js, pruned by render.
const castCache = new Map();
const castFrameKeys = new Set();
const lightFrameKeys = new Set();
// Ephemeral fog raster buffer + in-progress tool drafts (distinct from state.fog, the saved doc).
// Shared by fog.js (raster) and vision.js (reads resScale). Mutated, never rebound.
const fogBuf = { dirty: true, resScale: 1, activeStroke: null, stampDraft: null };

// Each floor is its own map (image + fog + tokens + stairs + view). The top-level
// imageData/fog/tokens/stairs/view fields below always mirror the CURRENT floor so the
// render/fog/token code can stay floor-agnostic; captureCurrentFloor()/applyFloor() swap
// them in and out of state.floors when navigating between floors.
function makeFloor(id) {
  return {
    id: id || `floor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    imageId: "",
    imageData: "",
    imageName: "",
    imageWidth: 0,
    imageHeight: 0,
    mapScale: 1,
    rooms: [],
    strokes: [],
    tokens: [],
    stairs: [],
    obstacles: [],
    lights: [],
    images: [],
    notes: [],
    view: { scale: 1, cx: 0, cy: 0, rotation: 0 },
  };
}

const state = {
  imageId: "",
  imageData: "",
  imageName: "",
  imageWidth: 0,
  imageHeight: 0,
  splash: { enabled: false, imageData: "", imageName: "" },
  blackout: false,
  los: { enabled: false, brightness: 0.5, darkness: false }, // line of sight + explored dim level + lighting gate (darkness: only lit areas are seen)
  grid: { enabled: true, snap: true, snapImages: false, size: 70, offsetX: 0, offsetY: 0, color: "#000000", opacity: 0.45 },
  map: { scale: 1 },
  fog: {
    rooms: [],
    strokes: [],
    toolSize: 70,
    toolShape: "round",
    stampShape: "rectangle",
    gmColor: "#080909",
    gmOpacity: DEFAULT_GM_FOG_OPACITY,
  },
  tokens: [],
  stairs: [],
  // Obstacle geometry (walls/doors/windows…) for the current floor — authored, mirrors the
  // floor record like tokens/stairs. Points are stored in cell units.
  obstacles: [],
  // Placed lights for the current floor (5d): { id, x, y, radius } in cell units. Authored,
  // per-floor like obstacles. Token-carried lights come later (5d-2).
  lights: [],
  // Droppable map images (synced to players; only those with showPlayers render there) and
  // GM-only floating notes (never synced). Both are per-floor like tokens/stairs.
  images: [],
  notes: [],
  stairColor: "#ffffff", // GM-only stair marker color (stairs never show on the player display)
  // Initiative tracker: a turn order shared across all floors. When showPlayers is on, a
  // compact order overlay is mirrored to the player display.
  initiative: { active: false, showPlayers: false, showOverlay: true, round: 1, turn: 0, combatants: [] },
  // Measurement: unit system + an optional calibrated cell size (world px) used when the
  // grid overlay is off but the map has its own printed grid.
  measure: { unit: "imperial", cellSize: 0 },
  // Views carry a rotation (degrees) so the map can be re-oriented. The GM "rotate map"
  // drives view.rotation; the player can be rotated independently via playerView.rotation.
  view: { scale: 1, cx: 0, cy: 0, rotation: 0 },
  playerView: { matchDM: true, scale: 1, cx: 0, cy: 0, rotation: 0 },
  currentFloorId: INITIAL_FLOOR_ID,
  floors: [makeFloor(INITIAL_FLOOR_ID)],
  floorPosition: 1, // player-side display only
  floorCount: 1, // player-side display only
};

function normalizeInput(value) {
  const number = Number(value);
  return Number.isNaN(number) ? value : number;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export {
  canvas, ctx, fogCanvas, fogCtx, liveCanvas, liveCtx, polyCanvas, polyCtx,
  strokeCanvas, strokeCtx, losCanvas, losCtx, darkCanvas, darkCtx, lightCanvas, lightCtx,
  exploredMasks, lightCache, shell, emptyState, channel, APP_NAME, LEGACY_APP_NAME, SAVE_FILE_VERSION,
  DB_NAME, DB_VERSION, MAP_STORE, IMAGE_STORE, MODULE_STORE, SESSION_STORE, TOKEN_STORE, FOG_MAX_EDGE,
  HISTORY_LIMIT, STAIRS_ICON_NEUTRAL, STAIRS_ICON_UP, STAIRS_ICON_DOWN, FEET_PER_CELL, MEASURE_UNITS, PING_DURATION, controls,
  isPlayer, DEFAULT_GM_FOG_OPACITY, INITIAL_FLOOR_ID, makeFloor, state, normalizeInput, uuid, escapeHtml,
  playerCam,
  tools,
  cur,
  hooks,
  sel,
  fogBuf,
  peerWindow,
  castCache,
  castFrameKeys,
  lightFrameKeys,
};
