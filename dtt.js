/* dtt.js — DTT module reader for vwag-table.
 * Reads a DungeonDraft .dtt module (a plain .zip) entirely in-browser with no libraries, so the
 * off-grid solar Pi needs no CDN. Pure: turns archive bytes into a structured object and stops
 * there. Applying that object to state (geometry/lights/tokens/notes) is the apply layer, which
 * rejoined here once geometry.js and vision.js existed (it needs both to place geometry).
 */


import {
  state, uuid,
} from "./state.js";
import {
  cellsToNative, pxPerCellNative, simplifyPolyline,
} from "./geometry.js";
import {
  invalidateCast,
} from "./vision.js";
import {
  obstacleDefaults,
} from "./rooms-obstacles.js";
// DTT modules are plain .zip archives (data.dtt + save.json + map.webp + fog.webp + thumb).
// We read them entirely in-browser with no libraries — the play table is an off-grid solar Pi,
// so a runtime CDN dependency is unacceptable. The browser's built-in DecompressionStream
// inflates the DEFLATE entries; we parse the zip central directory by hand.

// Inflate a raw DEFLATE byte stream (zip stores no zlib header, hence "deflate-raw").
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

// Read a ZIP from an ArrayBuffer: locate the End of Central Directory record, walk the central
// directory, and inflate (DEFLATE) or copy (STORED) each entry. Returns a Map of basename ->
// Uint8Array. DTT exports wrap their files in a module-named folder, so entries are keyed by
// basename. No ZIP64 / encryption — DTT archives are plain.
async function readZip(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  const entryCount = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOff = dv.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(buf.subarray(cd + 46, cd + 46 + nameLen));
    cd += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry
    // Local header lengths can differ from the central directory's; recompute the data offset.
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await inflateRaw(comp);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    out.set(name.slice(name.lastIndexOf("/") + 1), data);
  }
  return out;
}

// Parse a DTT module's archive entries into the structures vwag-table consumes. Step 6a uses
// only `size` and the map image; later steps read the obstacle kinds (data.dtt) and lights /
// tokens / notes (save.json). All geometry stays in DTT cell coordinates here — conversion to
// native px happens where each store ingests it (6b–6c).
function parseDtt(entries) {
  const td = new TextDecoder();
  const dataRaw = entries.get("data.dtt");
  const mapRaw = entries.get("map.webp");
  if (!dataRaw) throw new Error("data.dtt missing from module");
  if (!mapRaw) throw new Error("map.webp missing from module");
  const data = JSON.parse(td.decode(dataRaw));
  let save = {};
  const saveRaw = entries.get("save.json");
  if (saveRaw) { try { save = JSON.parse(td.decode(saveRaw)); } catch { save = {}; } }
  return {
    size: data.size || { x: 0, y: 0 },
    walls: data.walls || [],
    doors: data.doors || [],
    windows: data.windows || [],
    objects: data.objects || [],
    ethereals: data.ethereals || [],
    invisibles: data.invisibles || [],
    save,
    mapBytes: mapRaw,
  };
}


// ---------------------------------------------------------------------------------------------
// Apply layer: turn a parsed DTT object into live board state. Parked in app.js since step 3 until
// geometry + vision existed; now reunited with the reader. importDtt is the public entry; the rest
// are internal dispatch. loadDttFile (app.js) drives readZip -> parseDtt -> importDtt -> installMap.
// ---------------------------------------------------------------------------------------------

const DTT_SIMPLIFY_TOLERANCE = 0.2;
const DTT_TOKEN_COLORS = {
  red: "#e24a4a", blue: "#3b82f6", green: "#3aa655", yellow: "#d6a94d",
  orange: "#e08a3c", purple: "#8b5cf6", white: "#e8e8e8", black: "#222222",
  cyan: "#3ec6c6", magenta: "#d4537e", gray: "#9aa0a6", grey: "#9aa0a6",
};

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

export { readZip, parseDtt, importDtt };
