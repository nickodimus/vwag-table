/* geometry.js — coordinate authority for vwag-table.
 * The READ side of space: pure math (polyline simplify, point-in-poly, point-segment distance),
 * the cell/grid conversions, and the view transform chain (native <-> screen, rotation-aware,
 * follow-camera aware). Reads view + follow state from the hub; never mutates it. Changing the
 * framing (pan/zoom/rotate/fit, follow toggles, the easing loop) is the WRITE side and lives in
 * app.js for now, moving to view.js at step 10.
 */

import {
  canvas, ctx, isPlayer, state, playerCam,
} from "./state.js";

const FOLLOW_FIT_PADDING = 0.9; // fraction of the viewport the party box should fill (tunable feel)
const FOLLOW_FIT_MIN_CELLS = 8; // never frame tighter than this many cells — keeps context, caps zoom-in

// Iterative Douglas-Peucker: keep endpoints, drop interior points that lie within `tolerance` of
// the line between their kept neighbors. Iterative (explicit stack) so a 1,000+ point polyline
// can't overflow recursion. Operates on [[x,y],...] in cell coordinates; compares squared
// distances to avoid per-point square roots.
function simplifyPolyline(points, tolerance) {
  const n = points.length;
  if (n < 3) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const eps2 = tolerance * tolerance;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop();
    const first = seg[0], last = seg[1];
    const ax = points[first][0], ay = points[first][1];
    const bx = points[last][0], by = points[last][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let dmax = -1, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = points[i][0], py = points[i][1];
      let d2;
      if (len2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        const cross = dx * (py - ay) - dy * (px - ax);
        d2 = (cross * cross) / len2;
      }
      if (d2 > dmax) { dmax = d2; idx = i; }
    }
    if (dmax > eps2 && idx > first) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([points[i][0], points[i][1]]);
  return out;
}

function activeView() {
  // The player always renders from its (device-fitted) playerView framing. The GM keeps
  // playerView synced to its own view while Follow-GM is on, so this is correct in both
  // modes and needs no matchDM branch here.
  return isPlayer ? state.playerView : state.view;
}

// Player follow-camera: computes the effective view (center, and optionally fit-zoom) that tracks the
// party WITHOUT mutating the stored DM-set view — viewTransform applies it at render time, so the GM's
// player-view framing (the red box) stays the source of truth and toggling follow off reverts cleanly.
// Returns {cx, cy, k} to override the base view, or null when not following / no party.
function followView(rect, base, ms) {
  if (!isPlayer || !playerCam.follow) return null;
  const players = state.tokens.filter((t) => t.type === "player");
  if (!players.length) return null;

  // Center-only (2a): track the centroid, keep the DM's zoom.
  if (!playerCam.fitZoom) {
    let sx = 0, sy = 0;
    for (const t of players) { sx += t.x; sy += t.y; }
    return { cx: sx / players.length, cy: sy / players.length, k: base.scale };
  }

  // Fit-to-party (2b): center on the party's bounding-box center (not the centroid, so a stray token
  // isn't clipped) and zoom to fit it in the padded viewport. The zoom can pull OUT for a spread party,
  // but never zooms IN tighter than the DM's player-view framing (the red box) — that's the ceiling.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of players) {
    const r = tokenRadius(t);
    minX = Math.min(minX, t.x - r); maxX = Math.max(maxX, t.x + r);
    minY = Math.min(minY, t.y - r); maxY = Math.max(maxY, t.y + r);
  }
  const minSpan = FOLLOW_FIT_MIN_CELLS * gridCellNative(); // floor so one bunched token doesn't fill the screen
  const boxW = Math.max(maxX - minX, minSpan);
  const boxH = Math.max(maxY - minY, minSpan);
  const sFit = Math.min((rect.width * FOLLOW_FIT_PADDING) / boxW, (rect.height * FOLLOW_FIT_PADDING) / boxH);
  const kMin = fitScaleFor(rect.width, rect.height, base.rotation || 0); // don't zoom out past the whole map
  const kMax = base.scale; // the DM's player-view framing is the max zoom-in
  const k = Math.max(kMin, Math.min(kMax, sFit / ms));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, k };
}

function worldDims() {
  return { w: state.imageWidth * state.map.scale, h: state.imageHeight * state.map.scale };
}

// Scale that fits the (possibly rotated) map into a viewW x viewH box. At 90/270° the
// map's on-screen footprint has its width and height swapped.
function fitScaleFor(viewW, viewH, rotationDeg) {
  const { w, h } = worldDims();
  if (!w || !h) return 1;
  const swap = ((((rotationDeg || 0) % 180) + 180) % 180) === 90;
  const cw = swap ? h : w;
  const ch = swap ? w : h;
  return Math.min(viewW / cw, viewH / ch) * 0.96;
}

// World px per grid square for the current map (calibrated grid, else the measured cell).
function cellWorldPx() {
  return state.grid.size > 0 ? state.grid.size : state.measure.cellSize > 0 ? state.measure.cellSize : 0;
}

function viewTransform() {
  const rect = canvas.getBoundingClientRect();
  const v = activeView();
  const ms = state.map.scale || 1;
  let cx = v.cx, cy = v.cy, k = v.scale;
  const target = followView(rect, v, ms); // player follow-cam target (null when off / no party)
  if (target) {
    const eff = playerCam.ease || target; // glide toward the target; fall back to it before easing starts
    cx = eff.cx; cy = eff.cy; k = eff.k;
  }
  return {
    rect,
    k,
    ms,
    rot: ((v.rotation || 0) * Math.PI) / 180,
    cx,
    cy,
    centerX: rect.width / 2,
    centerY: rect.height / 2,
  };
}

function clientToCanvasPoint(point) {
  const rect = canvas.getBoundingClientRect();
  return { x: point.clientX - rect.left, y: point.clientY - rect.top };
}

// Current view rotation in radians (the angle the render transform applied). Markers like
// tokens and stairs counter-rotate by its negative so their art/labels stay screen-upright
// while their positions still ride the rotated map.
function currentViewRotation() {
  return ((activeView().rotation || 0) * Math.PI) / 180;
}

// Rotate the canvas about a native point so subsequent drawing at absolute coords keeps its
// position but is drawn upright on screen (cancels the view rotation).
function keepUpright(cx, cy, rot) {
  if (!rot) return;
  ctx.translate(cx, cy);
  ctx.rotate(-rot);
  ctx.translate(-cx, -cy);
}

// Screen <-> native conversions, rotation-aware. The view is centered on (cx,cy) in native
// coords, scaled by k*ms, and rotated by `rot` about the canvas center.
function screenToNative(point) {
  const t = viewTransform();
  const s = t.k * t.ms;
  const ox = point.x - t.centerX;
  const oy = point.y - t.centerY;
  const cos = Math.cos(-t.rot);
  const sin = Math.sin(-t.rot);
  return {
    x: t.cx + (ox * cos - oy * sin) / s,
    y: t.cy + (ox * sin + oy * cos) / s,
  };
}

function nativeToScreen(n) {
  const t = viewTransform();
  const s = t.k * t.ms;
  const dx = (n.x - t.cx) * s;
  const dy = (n.y - t.cy) * s;
  const cos = Math.cos(t.rot);
  const sin = Math.sin(t.rot);
  return {
    x: t.centerX + dx * cos - dy * sin,
    y: t.centerY + dx * sin + dy * cos,
  };
}

function gridCellNative() {
  return (state.grid.size || 70) / (state.map.scale || 1);
}

// Native px that represent one grid cell on the current map (the calibrated grid size, else the
// measured cell). This is the px<->cell bridge the obstacle/lighting work (steps 4-5) authors
// against; cellWorldPx() supplies the world cell size so there's no duplicate calibration logic.
function pxPerCellNative() {
  const world = cellWorldPx();
  return world > 0 ? world / (state.map.scale || 1) : 0;
}

function nativeToCells(p) {
  const ppc = pxPerCellNative();
  return ppc > 0 ? { x: p.x / ppc, y: p.y / ppc } : { x: p.x, y: p.y };
}

function cellsToNative(c) {
  const ppc = pxPerCellNative();
  return ppc > 0 ? { x: c.x * ppc, y: c.y * ppc } : { x: c.x, y: c.y };
}

function tokenRadius(token) {
  return Math.max(6, ((token.cells || 1) * gridCellNative()) / 2);
}

// Snap a native point to the nearest grid cell center (ungated).
function snapToGrid(native) {
  const ms = state.map.scale || 1;
  const size = state.grid.size || 70;
  const wx = native.x * ms;
  const wy = native.y * ms;
  const cx = Math.floor((wx - state.grid.offsetX) / size) * size + state.grid.offsetX + size / 2;
  const cy = Math.floor((wy - state.grid.offsetY) / size) * size + state.grid.offsetY + size / 2;
  return { x: cx / ms, y: cy / ms };
}

function snapNative(native) {
  return state.grid.snap ? snapToGrid(native) : native;
}

// Shortest distance from a point to a line segment (native px); used for right-click delete.
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export {
  simplifyPolyline, distToSegment, pointInPolygon, gridCellNative, pxPerCellNative, nativeToCells, cellsToNative, tokenRadius,
  snapToGrid, snapNative, worldDims, activeView, fitScaleFor, viewTransform, clientToCanvasPoint, currentViewRotation,
  keepUpright, screenToNative, nativeToScreen, followView, cellWorldPx, FOLLOW_FIT_PADDING, FOLLOW_FIT_MIN_CELLS,
};
