/* parse-uvtt.js — Universal VTT parser for vwag-table.
 * Reads a Universal VTT map (.uvtt / .dd2vtt / .df2vtt — the same JSON under three extensions,
 * exported by Dungeondraft, Dungeon Alchemist, Dungeon Fog, Mapforge, Arkenforge, and Foundry).
 * A UVTT file is a single JSON string with the map image embedded as base64 plus wall/light/door
 * geometry. Everything is expressed in GRID SQUARES (cells) — the same coordinate system the shared
 * installer expects — so parseUvtt is almost pure restructuring.
 *
 * parseUvtt is pure: JSON -> the normalized "content" object (see map-import.js), in cells, with
 * map_origin subtracted. importUvtt is the one-line apply that hands that content to the shared
 * installer. No cell->native baking, no state mutation lives here — that is installParsedMap's job,
 * shared with the DTT path.
 *
 * Units, verified against a real Dungeondraft export (format 0.3):
 *   - line_of_sight / objects_line_of_sight / portals.bounds / lights.position are in cells.
 *   - lights.range is in cells (GRID SQUARES), NOT feet — it maps straight to radiusCells with no
 *     /5 (that /5 is a DTT-only feet convention, applied in dtt.js, not here).
 *   - resolution.map_origin is a live offset, subtracted from every point so geometry lands on the
 *     image instead of shifted off it (real files carry a non-zero origin, e.g. {2,1}).
 *   - lights.color is AARRGGBB (alpha first); vwag wants #RRGGBB, so drop the leading alpha pair.
 *   - both line_of_sight AND objects_line_of_sight OCCLUDE, so both become blocking `wall` obstacles
 *     (vwag's `object` kind is see-through, so it is deliberately NOT used for UVTT objects).
 */

import {
  installParsedMap,
} from "./map-import.js";

// A UVTT light color is "AARRGGBB" (alpha first); vwag stores CSS "#RRGGBB". Drop the alpha pair.
// Naively prefixing "#" would yield an 8-digit #RRGGBBAA and the wrong hue. Falls back to the warm
// torch default on anything unexpected (missing/short strings).
function argbToHex(argb) {
  if (typeof argb !== "string") return "#ffd9a0";
  const hex = argb.replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(2)}`; // AARRGGBB -> RRGGBB
  if (hex.length === 6) return `#${hex}`;
  return "#ffd9a0";
}

// UVTT embeds the map as raw base64 (no data-URL prefix). Sniff the image type from the base64
// signature and wrap it as a data URL so the imported map rides the same rails as a file-picked
// image. Sniffing by base64 prefix avoids decoding a multi-megabyte byte array on the off-grid Pi.
function base64ToDataURL(b64) {
  if (typeof b64 !== "string" || !b64) return "";
  let mime = "image/png";
  if (b64.startsWith("/9j/")) mime = "image/jpeg";
  else if (b64.startsWith("iVBOR")) mime = "image/png";
  else if (b64.startsWith("UklGR")) mime = "image/webp";
  return `data:${mime};base64,${b64}`;
}

// Parse a UVTT JSON object into vwag's shared map "content" plus the calibration and image main.js
// needs for installMap. Pure: reads the object, returns a plain object, mutates nothing. All
// geometry is in cells with map_origin already subtracted; installParsedMap bakes cells -> native.
//
// Returns: { format, cellsX, cellsY, imageDataURL, obstacles, lights, tokens, notes, losEnabled }
//   obstacles : [ { kind:"wall"|"door", points:[[x,y],...], open?, defaultOpen? } ]  (cells)
//   lights    : [ { x, y (cells), radiusCells, color } ]
//   tokens/notes: empty — UVTT carries neither.
function parseUvtt(json) {
  if (!json || typeof json !== "object" || !json.resolution || !Array.isArray(json.line_of_sight)) {
    throw new Error("not a Universal VTT file (missing resolution / line_of_sight)");
  }
  const res = json.resolution;
  const origin = res.map_origin || { x: 0, y: 0 };
  const size = res.map_size || { x: 0, y: 0 };
  const cellsX = Math.round(size.x);
  const cellsY = Math.round(size.y);
  if (!cellsX || !cellsY) throw new Error("UVTT file has no grid size (resolution.map_size)");
  const ox = origin.x || 0;
  const oy = origin.y || 0;

  // Convert a UVTT polyline of {x,y} points (cells) to vwag's [x,y] pairs, subtracting the origin
  // so the geometry lands on the image. Drops any malformed points.
  const polyToCells = (poly) => (poly || [])
    .filter((pt) => pt && typeof pt.x === "number" && typeof pt.y === "number")
    .map((pt) => [pt.x - ox, pt.y - oy]);

  // Both LOS layers block sight -> install as walls. (UVTT objects are occluders, unlike vwag's
  // see-through `object` kind, so they are NOT mapped to `object`.)
  const obstacles = [];
  for (const poly of json.line_of_sight || []) {
    const pts = polyToCells(poly);
    if (pts.length >= 2) obstacles.push({ kind: "wall", points: pts });
  }
  for (const poly of json.objects_line_of_sight || []) {
    const pts = polyToCells(poly);
    if (pts.length >= 2) obstacles.push({ kind: "wall", points: pts });
  }
  // Portals become openable doors; `bounds` (two points) is the door segment. A portal with
  // closed:false arrives already open (passable). Default to closed when the flag is absent.
  for (const p of json.portals || []) {
    if (!p || !Array.isArray(p.bounds) || p.bounds.length < 2) continue;
    const pts = polyToCells(p.bounds);
    if (pts.length < 2) continue;
    const open = p.closed === false;
    obstacles.push({ kind: "door", points: pts, open, defaultOpen: open });
  }

  // Lights stay in cells; radiusCells is range in grid squares (converted to native px by the
  // installer). Position also has the origin subtracted.
  const lights = (json.lights || [])
    .filter((l) => l && l.position)
    .map((l) => ({
      x: (l.position.x || 0) - ox,
      y: (l.position.y || 0) - oy,
      radiusCells: typeof l.range === "number" ? l.range : 0,
      color: argbToHex(l.color),
    }));

  const imageDataURL = base64ToDataURL(json.image);
  if (!imageDataURL) throw new Error("UVTT file has no embedded image");

  return {
    format: json.format,
    cellsX,
    cellsY,
    imageDataURL,
    obstacles,
    lights,
    tokens: [],
    notes: [],
    // Walls + lights do nothing visible until line-of-sight is on; enable it so a UVTT import lands
    // playable with dynamic lighting already wired (the whole point of importing UVTT).
    losEnabled: true,
  };
}

// Public entry: parseUvtt already produced shared content, so install it directly.
function importUvtt(parsed) {
  installParsedMap(parsed);
}

export { parseUvtt, importUvtt };
