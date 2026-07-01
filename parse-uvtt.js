/* parse-uvtt.js — Universal VTT importer for vwag-table.
 * Reads a Universal VTT map (.uvtt / .dd2vtt / .df2vtt — the same JSON under three extensions,
 * exported by Dungeondraft, Dungeon Alchemist, Dungeon Fog, Mapforge, Arkenforge, and Foundry).
 * A UVTT file is a single JSON string with the map image embedded as base64 plus wall/light/door
 * geometry. Everything is expressed in GRID SQUARES (cells) — which is exactly the coordinate
 * system vwag-table's obstacle/light stores already use — so the geometry maps almost 1:1.
 *
 * Structure mirrors dtt.js on purpose: parseUvtt is pure (JSON -> a normalized plain object in
 * cell coordinates) and importUvtt is the apply layer that bakes that object into live board state.
 * main.js sniffs the file format and drives readZip/parseDtt/importDtt (DTT) or
 * parseUvtt/importUvtt (UVTT) through the shared installMap seam.
 *
 * Units, verified against a real Dungeondraft export (format 0.3):
 *   - line_of_sight / objects_line_of_sight / portals.bounds / lights.position are in cells.
 *   - lights.range is in cells (GRID SQUARES), NOT feet — so it converts to native px as
 *     `range * pxPerCellNative()`. There is NO /5 here (that /5 is a DTT-only convention).
 *   - resolution.map_origin is a live offset: it is subtracted from every point so geometry lands
 *     on the image instead of shifted off it (real files carry a non-zero origin, e.g. {2,1}).
 *   - lights.color is AARRGGBB (alpha first); vwag wants #RRGGBB, so drop the leading alpha pair.
 */

import {
  state, uuid,
} from "./state.js";
import {
  cellsToNative, simplifyPolyline, pxPerCellNative,
} from "./geometry.js";
import {
  invalidateCast,
} from "./vision.js";
import {
  obstacleDefaults,
} from "./rooms-obstacles.js";
// Reuse the DTT importer's obstacle-editing knobs so wall simplification/chunking behaves
// identically across formats (Path A: share the small helpers, don't unify the installers yet).
import {
  chunkPolyline, DTT_SIMPLIFY_TOLERANCE, DTT_OBSTACLE_MAX_POINTS,
} from "./dtt.js";

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
// image (state.imageData is a data URL everywhere downstream). Sniffing by base64 prefix avoids
// decoding a multi-megabyte byte array on the off-grid Pi.
function base64ToDataURL(b64) {
  if (typeof b64 !== "string" || !b64) return "";
  let mime = "image/png";
  if (b64.startsWith("/9j/")) mime = "image/jpeg";
  else if (b64.startsWith("iVBOR")) mime = "image/png";
  else if (b64.startsWith("UklGR")) mime = "image/webp";
  return `data:${mime};base64,${b64}`;
}

// Parse a UVTT JSON object into vwag's normalized intermediate shape, entirely in cell coordinates
// with map_origin already subtracted. Pure: reads the object, returns a plain object, mutates
// nothing. The apply step (importUvtt) bakes cells -> native px and writes to state.
//
// Returns: { format, cellsX, cellsY, walls, objects, doors, lights, imageDataURL }
//   walls/objects : arrays of polylines, each an array of [x,y] pairs in cells
//   doors         : array of { points:[[x,y],...], closed:boolean }
//   lights        : array of { x, y (cells), radiusCells, color:"#rrggbb" }
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

  const walls = (json.line_of_sight || [])
    .map(polyToCells).filter((p) => p.length >= 2);
  // objects_line_of_sight are sight-blocking furniture/pillars — they OCCLUDE, so they become
  // blocking walls, NOT vwag's see-through `object` kind. (importUvtt installs both as walls.)
  const objects = (json.objects_line_of_sight || [])
    .map(polyToCells).filter((p) => p.length >= 2);

  // Portals become openable doors. `bounds` (two points) is the door segment; `closed:false`
  // means the portal starts open (passable). Default to closed when the flag is absent.
  const doors = (json.portals || [])
    .filter((p) => p && Array.isArray(p.bounds) && p.bounds.length >= 2)
    .map((p) => ({ points: polyToCells(p.bounds), closed: p.closed !== false }))
    .filter((d) => d.points.length >= 2);

  // Lights stay in cells here; radiusCells is range in grid squares (converted to native px in the
  // apply step). Position also has the origin subtracted.
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
    walls,
    objects,
    doors,
    lights,
    imageDataURL,
  };
}

// Apply a parsed UVTT object to live board state: geometry (walls/objects/doors), placed lights,
// and the line-of-sight flag. Runs inside installMap's onReady seam, after applyGridFromCells has
// set the grid from map_size — so pxPerCellNative()/cellsToNative bake against the image-locked
// native scale, exactly like importDtt. Replaces the stores wholesale (a fresh import never
// appends). UVTT carries no tokens or notes, so those install empty.
function importUvtt(parsed) {
  const obstacles = [];

  // Bake one cell-space polyline into an obstacle record (or several, for chunked walls). Mirrors
  // dtt.js importObstacles: simplify in cells, then cellsToNative so geometry is locked to the
  // image and independent of the display grid. Only walls fragment (granular erase on long runs).
  const addPoly = (poly, kind, extra) => {
    if (!Array.isArray(poly) || poly.length < 2) return;
    const baked = simplifyPolyline(poly, DTT_SIMPLIFY_TOLERANCE).map((p) => {
      const n = cellsToNative({ x: p[0], y: p[1] });
      return [n.x, n.y];
    });
    const pieces = kind === "wall" ? chunkPolyline(baked, DTT_OBSTACLE_MAX_POINTS) : [baked];
    for (const points of pieces) {
      obstacles.push({
        id: uuid(), kind, points, ...obstacleDefaults(kind), defaultOpen: false, ...(extra || {}),
      });
    }
  };

  // Both LOS layers block sight -> install as walls. (vwag's `object` kind is see-through, so it
  // is deliberately not used for UVTT objects.)
  for (const poly of parsed.walls) addPoly(poly, "wall");
  for (const poly of parsed.objects) addPoly(poly, "wall");
  // Doors: a portal with closed:false arrives already open (passable).
  for (const d of parsed.doors) addPoly(d.points, "door", { defaultOpen: !d.closed, open: !d.closed });
  state.obstacles = obstacles;

  // Lights: position cells -> native; range is in GRID SQUARES, so radius = range * pxPerCell
  // (NOT /5). color carries through from the UVTT file (imported UVTT lights are colored).
  const ppc = pxPerCellNative();
  state.lights = parsed.lights.map((l) => {
    const n = cellsToNative({ x: l.x, y: l.y });
    return { id: uuid(), x: n.x, y: n.y, radius: (l.radiusCells || 0) * ppc, color: l.color };
  });

  state.tokens = [];
  state.notes = [];
  // Walls + lights do nothing visible until line-of-sight is on; enable it so a UVTT import lands
  // playable with dynamic lighting already wired (the whole point of importing UVTT).
  state.los.enabled = true;

  invalidateCast();
}

export { parseUvtt, importUvtt };
