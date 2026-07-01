/* dtt.js — DTT module reader for vwag-table.
 * Reads a DungeonDraft .dtt module (a plain .zip) entirely in-browser with no libraries, so the
 * off-grid solar Pi needs no CDN. Pure: turns archive bytes into a structured object and stops
 * there. Applying that object to state (geometry/lights/tokens/notes) is the apply layer, which
 * rejoined here once geometry.js and vision.js existed (it needs both to place geometry).
 */


import {
  installParsedMap,
} from "./map-import.js";
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
// Normalize layer: turn a parsed DTT object into the shared, format-agnostic map "content" (see
// map-import.js) — all geometry in cells. importDtt is the public entry (main.js drives readZip ->
// parseDtt -> importDtt); the heavy lifting (bake to native px, write stores) is installParsedMap.
// ---------------------------------------------------------------------------------------------

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

// Map a parsed DTT into the shared content shape. Geometry stays in cells (installParsedMap bakes
// it): the six DTT obstacle kinds map straight across, already open polylines in cell coords. Light
// radii and token size/torch radii are in FEET in this format, so they convert to cells here (÷5)
// before handoff — the installer is unit-agnostic and expects cells.
//
// The ÷5 is CORRECT — not a 5x shrink (suspected once, cleared). DTT keeps positions in cells but
// distances in feet; the tell is token `size` defaulting to 5, which ÷5 = 1 cell (a Medium
// creature) — a cells default would be 1, not 5. Unit-consistent end to end: the in-app Light tool
// stores cells × pxPerCellNative(), token torches store dim_radius ÷ 5 cells consumed as light × ppc
// in vision.js, and vision.js reads a placed light's radius as native px. Don't re-flag.
function normalizeDtt(dtt) {
  const KINDS = [
    ["walls", "wall"], ["doors", "door"], ["windows", "window"],
    ["objects", "object"], ["ethereals", "ethereal"], ["invisibles", "invisible"],
  ];
  const obstacles = [];
  for (const [src, kind] of KINDS) {
    for (const poly of dtt[src] || []) {
      if (!Array.isArray(poly) || poly.length < 2) continue;
      obstacles.push({ kind, points: poly });
    }
  }

  const save = dtt.save || {};

  const lights = [];
  for (const l of save.lights || []) {
    if (l.active === false) continue; // inactive lights are skipped
    const p = l.position || {};
    lights.push({ x: p.x || 0, y: p.y || 0, radiusCells: (l.radius || 0) / 5 });
  }

  // Token art path is a local file outside the zip, so images import blank — type + color stand in.
  const tokens = [];
  for (const t of save.tokens || []) {
    const p = t.position || {};
    tokens.push({
      x: p.x || 0, y: p.y || 0,
      cells: Math.max(1, Math.round((t.size || 5) / 5)),
      color: DTT_TOKEN_COLORS[t.border_color] || "#d6a94d",
      label: "",
      type: dttTokenType(t.type),
      light: t.torch_on ? (t.dim_radius || 0) / 5 : 0,
      image: "",
    });
  }

  // DTT room labels become GM-only floating notes (vwag's notes feature, not the reserved pins
  // field, which stays for Encounter-Area linkage).
  const notes = [];
  for (const nt of save.notes || []) {
    const p = nt.position || {};
    notes.push({ x: p.x || 0, y: p.y || 0, text: nt.text || "", scale: 1 });
  }

  const losEnabled = typeof save.line_of_sight === "boolean" ? save.line_of_sight : null;

  return { obstacles, lights, tokens, notes, losEnabled };
}

// Public entry: normalize the parsed DTT to shared content, then install it.
function importDtt(dtt) {
  installParsedMap(normalizeDtt(dtt));
}

export { readZip, parseDtt, importDtt };
