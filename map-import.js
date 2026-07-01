/* map-import.js — the one place a parsed map becomes live board state.
 *
 * Every import format (DTT modules via dtt.js, Universal VTT via parse-uvtt.js) normalizes to the
 * SAME plain "content" object, in CELL coordinates, and hands it here. installParsedMap bakes that
 * content to native px and writes the stores. Format-specific quirks — DTT's feet-based light radii,
 * UVTT's grid-unit radii and door open-state, which layers block sight — are resolved by each
 * parser BEFORE this point, so this installer is completely format-agnostic. Adding a new format is
 * "write a parser that emits this shape," never "touch the installer."
 *
 * Content contract (all positions/polylines in CELLS):
 *   obstacles : [ { kind, points:[[x,y],...], open?:bool, defaultOpen?:bool } ]
 *   lights    : [ { x, y, radiusCells, color?:string } ]
 *   tokens    : [ { x, y, cells, color, label, type, light, image } ]   // x,y cells; light in cells
 *   notes     : [ { x, y, text, scale } ]
 *   losEnabled: boolean | null    // null/undefined -> leave the current LoS toggle untouched
 *
 * A fresh import replaces each store wholesale — it never appends to whatever was on the board.
 * Runs inside installMap's onReady seam, after the grid is set from the map's own calibration, so
 * pxPerCellNative()/cellsToNative() bake against the image-locked native scale.
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

// How aggressively imported wall/obstacle polylines are thinned, in CELLS (resolution-independent),
// via Douglas-Peucker. Kept conservative at 0.2 (~1 ft on a 5 ft grid): higher values (0.4 = ~2 ft)
// can bow a wall far enough to pinch a 1-cell tunnel shut and make it impassable to a token. This
// still cuts Caves of Chaos from ~8,600 raw wall points to ~1,900. Performance comes from caching the
// cast (it rebuilds only on real geometry changes), NOT from crushing geometry — don't raise this to
// chase speed; reach for cast-cache and viewport culling instead.
const MAP_SIMPLIFY_TOLERANCE = 0.2;
// Imported walls arrive as a few enormous single polylines (Caves of Chaos has one 1,000+ point run
// spanning much of the map). Stored as one obstacle each, a single two-finger erase in Draw mode
// nukes the whole run. Chunking a long wall into records of at most this many points — sharing the
// boundary vertex between neighbours so the wall stays continuous — makes an erase delete one modest
// section instead. This is purely an editing-granularity knob: the cast sees identical segments and
// the render is unchanged, so it has no performance effect (don't reach for it to chase speed). Walls
// only; doors/windows/objects stay whole (a door must remain one openable record).
const MAP_OBSTACLE_MAX_POINTS = 16;

// Split a polyline into consecutive pieces of at most maxPts points each. Neighbouring pieces SHARE
// their boundary vertex (piece i ends on the same point piece i+1 begins on), so the reassembled wall
// has no gap and the cast produces exactly the same segments — only the obstacle-record grouping
// changes. Every returned piece has >= 2 points (the loop stops before it could emit a lone tail
// vertex). Short polylines (<= maxPts) pass through untouched as a single piece.
function chunkPolyline(points, maxPts) {
  if (points.length <= maxPts) return [points];
  const pieces = [];
  const step = maxPts - 1; // overlap one vertex so pieces stay joined
  for (let i = 0; i < points.length - 1; i += step) {
    pieces.push(points.slice(i, i + maxPts));
  }
  return pieces;
}

// Bake one cell-space obstacle into one or more records. Simplify in cell space (tolerance is in
// cells), then bake to native px so geometry is locked to the image and independent of the display
// grid. Only walls fragment into smaller records (giant runs, granular erase matters); doors/
// windows/objects/etc. stay whole (a door must remain one openable unit). Blocking rules come from
// obstacleDefaults(kind); door open-state (if any) is carried from the parser.
function installObstacles(list) {
  const obstacles = [];
  for (const ob of list || []) {
    const poly = ob.points;
    if (!Array.isArray(poly) || poly.length < 2) continue;
    const baked = simplifyPolyline(poly, MAP_SIMPLIFY_TOLERANCE).map((p) => {
      const n = cellsToNative({ x: p[0], y: p[1] });
      return [n.x, n.y];
    });
    const pieces = ob.kind === "wall" ? chunkPolyline(baked, MAP_OBSTACLE_MAX_POINTS) : [baked];
    for (const points of pieces) {
      const rec = {
        id: uuid(), kind: ob.kind, points, ...obstacleDefaults(ob.kind), defaultOpen: !!ob.defaultOpen,
      };
      if (ob.open) rec.open = true; // a portal imported already-open (UVTT closed:false)
      obstacles.push(rec);
    }
  }
  state.obstacles = obstacles;
}

// Bake placed lights: position cells -> native; radiusCells -> native px via pxPerCellNative().
// The feet-vs-grid-units difference between formats is already resolved (each parser emits cells),
// so there is no /5 here. Color rides through when the format carries one (UVTT does, DTT doesn't).
function installLights(list) {
  const ppc = pxPerCellNative();
  const lights = [];
  for (const l of list || []) {
    const n = cellsToNative({ x: l.x || 0, y: l.y || 0 });
    const rec = { id: uuid(), x: n.x, y: n.y, radius: (l.radiusCells || 0) * ppc };
    if (l.color) rec.color = l.color;
    lights.push(rec);
  }
  state.lights = lights;
}

// Bake tokens: position cells -> native (vwag tokens carry native coords). size (`cells`) and the
// token torch radius (`light`, in cells) are unit-agnostic and pass through untouched.
function installTokens(list) {
  const tokens = [];
  for (const t of list || []) {
    const n = cellsToNative({ x: t.x || 0, y: t.y || 0 });
    tokens.push({
      id: uuid(), x: n.x, y: n.y,
      cells: t.cells, color: t.color, label: t.label || "", type: t.type,
      light: t.light || 0, image: t.image || "",
    });
  }
  state.tokens = tokens;
}

// Bake notes (GM-only floating labels): position cells -> native; text/scale 1:1.
function installNotes(list) {
  const notes = [];
  for (const nt of list || []) {
    const n = cellsToNative({ x: nt.x || 0, y: nt.y || 0 });
    notes.push({ id: uuid(), x: n.x, y: n.y, text: nt.text || "", scale: nt.scale || 1 });
  }
  state.notes = notes;
}

// Install a normalized map into the live stores: geometry, lights, tokens, notes, and the LoS flag.
// A single cast invalidation covers all of them; the LoS checkbox re-syncs when installMap calls
// refreshFloorUI right after this runs.
function installParsedMap(content) {
  installObstacles(content.obstacles);
  installLights(content.lights);
  installTokens(content.tokens);
  installNotes(content.notes);
  if (content.losEnabled != null) state.los.enabled = content.losEnabled;
  invalidateCast();
}

export { installParsedMap };
