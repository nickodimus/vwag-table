/* dtt.js — DTT module reader for vwag-table.
 * Reads a DungeonDraft .dtt module (a plain .zip) entirely in-browser with no libraries, so the
 * off-grid solar Pi needs no CDN. Pure: turns archive bytes into a structured object and stops
 * there. Applying that object to state (geometry/lights/tokens/notes) is the apply layer, which
 * stays in app.js until geometry.js and vision.js exist, then rejoins here.
 */

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

export { readZip, parseDtt };
