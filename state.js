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
// 5e: colored-light tint for the current frame — each source's wall-occluded reach painted in
// its own color, composited additively over the map on both the GM and player views.
const tintCanvas = document.createElement("canvas");
const tintCtx = tintCanvas.getContext("2d");
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

// 5e status conditions (token.conditions holds the active ids). Each glyph is an SVG path in a
// 24x24 box, stroked like the stair icons; `d` is shared by the canvas markers (tokens.js builds a
// Path2D) and the authoring grid (index.html buttons, built in main.js from this list). The order
// here is the order markers appear above the token and buttons appear in the panel. Exhaustion is
// leveled, so it lives in its own field (token.exhaustion 0-6) and renders one marker with a numeral.
const CONDITIONS = [
  { id: "blinded", label: "Blinded", color: "#6b8cae", d: "M2 12 C5 7 19 7 22 12 C19 17 5 17 2 12 Z M12 9 a3 3 0 1 0 0.01 0 M4 4 L20 20" },
  { id: "charmed", label: "Charmed", color: "#d4537e", d: "M12 20 C12 20 3 14 3 8 A4.5 4.5 0 0 1 12 6 A4.5 4.5 0 0 1 21 8 C21 14 12 20 12 20 Z" },
  { id: "deafened", label: "Deafened", color: "#9c9a92", d: "M9 18 a5 5 0 0 1 -2 -4 a5 5 0 1 1 10 0 c0 2 -2 2 -2 4 M4 4 L20 20" },
  { id: "frightened", label: "Frightened", color: "#8f88e6", d: "M12 4 L12 14 M12 18 a0.7 0.7 0 1 0 0.01 0" },
  { id: "grappled", label: "Grappled", color: "#e07a4d", d: "M5 7 L10 12 L5 17 M19 7 L14 12 L19 17" },
  { id: "incapacitated", label: "Incapacitated", color: "#9c9a92", d: "M12 12 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 M6 6 L18 18" },
  { id: "invisible", label: "Invisible", color: "#3fbf94", d: "M5 20 L5 11 a7 7 0 0 1 14 0 L19 20 L16 18 L13 20 L10 18 L7 20 Z M9.5 11 a0.7 0.7 0 1 0 0.01 0 M14.5 11 a0.7 0.7 0 1 0 0.01 0" },
  { id: "paralyzed", label: "Paralyzed", color: "#ef9f27", d: "M13 2 L5 13 L11 13 L9 22 L19 9 L13 9 Z" },
  { id: "petrified", label: "Petrified", color: "#b4b2a9", d: "M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z M4 7.5 L12 12 L20 7.5 M12 12 L12 21" },
  { id: "poisoned", label: "Poisoned", color: "#97c459", d: "M12 3 C12 3 6 11 6 15 a6 6 0 0 0 12 0 C18 11 12 3 12 3 Z" },
  { id: "prone", label: "Prone", color: "#b4b2a9", d: "M12 4 L12 17 M6 11 L12 18 L18 11" },
  { id: "restrained", label: "Restrained", color: "#4f9be0", d: "M8 10 L8 7 a4 4 0 0 1 8 0 L16 10 M6 10 L18 10 L18 20 L6 20 Z" },
  { id: "stunned", label: "Stunned", color: "#f0b53e", d: "M10 4 L11.5 8 L15.5 9.5 L11.5 11 L10 15 L8.5 11 L4.5 9.5 L8.5 8 Z M17 13 L17.8 15 L19.8 15.8 L17.8 16.6 L17 18.6 L16.2 16.6 L14.2 15.8 L16.2 15 Z" },
  { id: "unconscious", label: "Unconscious", color: "#8d90a8", d: "M7 8 L13 8 L7 16 L13 16 M15 5 L19 5 L15 10 L19 10" },
  { id: "concentration", label: "Concentration", color: "#8f88e6", d: "M12 12 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0 M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0" },
];
const EXHAUSTION_ICON = { id: "exhaustion", label: "Exhaustion", color: "#e08a52", d: "M3 9 L16 9 L16 15 L3 15 Z M16 11 L19 11 L19 13 L16 13 M5 11 L7 11 L7 13 L5 13 Z" };
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
  losSource: document.getElementById("losSource"),
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
  tokenSelConditions: document.getElementById("tokenSelConditions"),
  tokenSelExhDown: document.getElementById("tokenSelExhDown"),
  tokenSelExhUp: document.getElementById("tokenSelExhUp"),
  tokenSelExhVal: document.getElementById("tokenSelExhVal"),
  tokenSelDown: document.getElementById("tokenSelDown"),
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
  lightColor: document.getElementById("lightColor"),
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
  stairSelPanel: document.getElementById("stairSelPanel"),
  stairSelFloor: document.getElementById("stairSelFloor"),
  stairSelLabel: document.getElementById("stairSelLabel"),
  stairSelDelete: document.getElementById("stairSelDelete"),
  floorOverlay: document.getElementById("floorOverlay"),
  floorName: document.getElementById("floorName"),
  addFloorUp: document.getElementById("addFloorUp"),
  addFloorDown: document.getElementById("addFloorDown"),
  deleteFloor: document.getElementById("deleteFloor"),
  pushToTable: document.getElementById("pushToTable"),
  pinTable: document.getElementById("pinTable"),
  followInitiative: document.getElementById("followInitiative"),
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
  dragMeasureLine: null,
  calibrating: null,
  calibrationDraft: null,
  lightRadius: 3, // radius (cells) applied to newly placed lights — small=torch, large=firepit
  lightColor: "#ffd9a0", // color applied to newly placed lights (warm torch by default)
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
const sel = { image: null, note: null, token: null, stair: null, playerTokens: [], marquee: null };
// Handle to the popped-out player window (GM side); the player side reaches the GM via window.opener.
// Mutated when the popup opens or a message identifies its source. Never rebound across modules.
const peerWindow = { ref: null };
// GM-side interaction + overlay state. mode = active tool; lastPointer = last cursor pos (for previews);
// castDebug = draw the LOS cast polygon; playerFrame* = the dashed rect on the GM screen showing the player viewport.
const ui = { mode: "pan", lastPointer: { clientX: 0, clientY: 0 }, castDebug: false, playerFrameColor: "#e24a4a", playerFrameOpacity: 0.9, playerViewport: null, showPlayerFrame: true, pinTable: false, followInitiative: false };
// The two background <img> sources: the active map and the splash image.
const scene = { map: new Image(), splash: new Image() };
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
  los: { enabled: false, brightness: 0.5, darkness: false, source: "party" }, // line of sight + explored dim level + lighting gate (darkness: only lit areas are seen); source = whose sight is unioned into the visible area (party = every player token; later: active combatant / selected token)
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
  // Placed lights for the current floor (5d): { id, x, y, radius, color }. Authored, per-floor
  // like obstacles. color (5e) tints the light's reach; absent on old saves -> warm default.
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
  activeFloorId: INITIAL_FLOOR_ID, // the floor the players' table is showing; == currentFloorId unless the table is pinned
  floors: [makeFloor(INITIAL_FLOOR_ID)],
  floorPosition: 1, // player-side display only
  floorCount: 1, // player-side display only
  floorSummary: [], // player-side only: names-only "rest of party" lines when the party is split
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
  strokeCanvas, strokeCtx, losCanvas, losCtx, darkCanvas, darkCtx, lightCanvas, lightCtx, tintCanvas, tintCtx,
  exploredMasks, lightCache, shell, emptyState, channel, APP_NAME, LEGACY_APP_NAME, SAVE_FILE_VERSION,
  DB_NAME, DB_VERSION, MAP_STORE, IMAGE_STORE, MODULE_STORE, SESSION_STORE, TOKEN_STORE, FOG_MAX_EDGE,
  HISTORY_LIMIT, STAIRS_ICON_NEUTRAL, STAIRS_ICON_UP, STAIRS_ICON_DOWN, FEET_PER_CELL, MEASURE_UNITS, PING_DURATION, controls,
  CONDITIONS, EXHAUSTION_ICON,
  isPlayer, DEFAULT_GM_FOG_OPACITY, INITIAL_FLOOR_ID, makeFloor, state, normalizeInput, uuid, escapeHtml,
  playerCam,
  tools,
  cur,
  hooks,
  sel,
  fogBuf,
  peerWindow,
  ui,
  scene,
  castCache,
  castFrameKeys,
  lightFrameKeys,
};
