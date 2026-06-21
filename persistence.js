/* persistence.js — serialization primitives for save/load.
 * Pure data transforms: capture a floor, split live state into module + session, derive cell grids,
 * migrate old save versions forward, validate/merge session data, hydrate floor images from IndexedDB.
 * No rendering, no UI, no db writes of records — the save/delete/import ACTIONS that combine these with
 * db writes, the library panel, and re-render orchestration stay in app.js until the orchestrator layer.
 */

import {
  deleteMapRecord, getImage, listMapRecords, putImage, saveModuleRecord, saveSessionRecord,
} from "./db.js";
import {
  APP_NAME, DEFAULT_GM_FOG_OPACITY, INITIAL_FLOOR_ID, LEGACY_APP_NAME, SAVE_FILE_VERSION, state, uuid,
} from "./state.js";

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

export {
  validateSessionData, migrateState, hydrateFloorImages, mergeModuleSession, migrateMapsToModulesAndSessions, captureCurrentFloor, splitState, makeMapId,
  deriveCellGrid,
};
