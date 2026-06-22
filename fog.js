/* fog.js — the fog-of-war raster engine.
 * Builds and composites the fog layers from state.fog (rooms + freehand strokes): resize the
 * offscreen buffers, stamp room/stroke geometry, paint the live brush/stamp preview, composite
 * the result over the view. Pure raster — reads state + the hub canvases, draws, returns nothing.
 * The undo/redo history, the ribbon UI, and the tool-action shells (clear/fill/stamp-shape/brush)
 * stay in app.js. Ephemeral fog buffer + in-progress tool drafts live in the hub `fogBuf` object.
 */

import {
  FOG_MAX_EDGE, ctx, cur, darkCanvas, fogBuf, fogCanvas, fogCtx, isPlayer,
  lightCanvas, liveCanvas, liveCtx, losCanvas, polyCanvas, polyCtx, state, strokeCanvas,
  strokeCtx, tintCanvas,
} from "./state.js";

function resizeFogLayer() {
  const maxEdge = Math.max(state.imageWidth, state.imageHeight) || 1;
  fogBuf.resScale = Math.min(1, FOG_MAX_EDGE / maxEdge);
  const w = Math.max(1, Math.round(state.imageWidth * fogBuf.resScale));
  const h = Math.max(1, Math.round(state.imageHeight * fogBuf.resScale));
  [fogCanvas, liveCanvas, polyCanvas, strokeCanvas, losCanvas, darkCanvas, lightCanvas, tintCanvas].forEach((c) => {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  });
}

// Build the freeform layer (brush paint, bucket fill, brush erase, and the polygon-shaped
// erases produced by right-clicking an area). Replayed in creation order, so an erase only
// affects fog that already existed — painting back over an erased spot works as expected.
function buildStrokeLayer() {
  const color = isPlayer ? "#080909" : state.fog.gmColor;
  strokeCtx.setTransform(1, 0, 0, 1, 0, 0);
  strokeCtx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
  state.fog.strokes.forEach((stroke) => {
    strokeCtx.save();
    strokeCtx.globalAlpha = 1;
    strokeCtx.fillStyle = color;
    strokeCtx.globalCompositeOperation = stroke.kind === "erase" ? "destination-out" : "source-over";
    if (stroke.kind === "fill") {
      strokeCtx.fillRect(0, 0, strokeCanvas.width, strokeCanvas.height);
    } else if (stroke.region === "polygon" && stroke.points) {
      strokeCtx.fill(roomPathFog(stroke.points));
    } else {
      strokeCtx.fill(strokePathFog(stroke));
    }
    strokeCtx.restore();
  });
}

// Rebuild the committed fog bitmap as the union of the polygon layer and the freeform layer.
// Full opacity; the GM tint/opacity is applied once at composite time so overlap never darkens.
function rebuildFog() {
  resizeFogLayer();
  const color = isPlayer ? "#080909" : state.fog.gmColor;
  // Polygon/stamp areas.
  polyCtx.setTransform(1, 0, 0, 1, 0, 0);
  polyCtx.clearRect(0, 0, polyCanvas.width, polyCanvas.height);
  polyCtx.save();
  polyCtx.globalAlpha = 1;
  polyCtx.fillStyle = color;
  state.fog.rooms.forEach((room) => {
    if (room.revealed) return;
    polyCtx.fill(roomPathFog(room.points));
  });
  polyCtx.restore();
  // Freeform layer.
  buildStrokeLayer();
  // Union the two into the displayed fog bitmap.
  fogCtx.setTransform(1, 0, 0, 1, 0, 0);
  fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
  fogCtx.drawImage(polyCanvas, 0, 0);
  fogCtx.drawImage(strokeCanvas, 0, 0);
  fogBuf.dirty = false;
}

function compositeFog() {
  let source = fogCanvas;
  if (fogBuf.activeStroke) {
    // Preview the in-progress brush stroke on the freeform layer only, then re-union the
    // polygon layer beneath it so an erase preview never appears to remove polygon fog.
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    liveCtx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    liveCtx.drawImage(strokeCanvas, 0, 0);
    liveCtx.save();
    liveCtx.globalCompositeOperation = fogBuf.activeStroke.kind === "erase" ? "destination-out" : "source-over";
    liveCtx.globalAlpha = 1;
    liveCtx.fillStyle = isPlayer ? "#080909" : state.fog.gmColor;
    liveCtx.fill(strokePathFog(fogBuf.activeStroke));
    liveCtx.restore();
    liveCtx.save();
    liveCtx.globalCompositeOperation = "destination-over";
    liveCtx.drawImage(polyCanvas, 0, 0);
    liveCtx.restore();
    source = liveCanvas;
  }
  ctx.save();
  ctx.globalAlpha = isPlayer ? 1 : state.fog.gmOpacity;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, fogCanvas.width, fogCanvas.height, 0, 0, state.imageWidth, state.imageHeight);
  ctx.restore();
}

function roomPathFog(points) {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x * fogBuf.resScale, points[0].y * fogBuf.resScale);
  points.slice(1).forEach((p) => path.lineTo(p.x * fogBuf.resScale, p.y * fogBuf.resScale));
  path.closePath();
  return path;
}

function strokePathFog(stroke) {
  const path = new Path2D();
  const radius = (stroke.size * fogBuf.resScale) / 2;
  stroke.points.forEach((point) => {
    const x = point.x * fogBuf.resScale;
    const y = point.y * fogBuf.resScale;
    if (stroke.shape === "square") {
      path.rect(x - radius, y - radius, radius * 2, radius * 2);
    } else {
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
    }
  });
  return path;
}

function polygonCentroid(points) {
  let x = 0;
  let y = 0;
  points.forEach((p) => {
    x += p.x;
    y += p.y;
  });
  return { x: x / points.length, y: y / points.length };
}

function drawStampDraft() {
  if (!fogBuf.stampDraft) return;
  const points = stampPolygon(fogBuf.stampDraft.shape, fogBuf.stampDraft.start, fogBuf.stampDraft.end);
  if (!points) return;
  ctx.save();
  ctx.fillStyle = "rgba(127, 182, 166, 0.18)";
  ctx.strokeStyle = "rgba(127, 182, 166, 0.95)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  drawPolygon(points);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPolygon(points) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.closePath();
}

// Build a polygon (in native coords) for a drag-drawn fog stamp. Shapes become regular
// rooms, so they reveal, get outlines/names, undo, and delete just like polygon areas.
// "square" and "circle" force an equal-sided bounding box following the drag direction.
function stampPolygon(shape, a, b) {
  let x0 = Math.min(a.x, b.x);
  let y0 = Math.min(a.y, b.y);
  let x1 = Math.max(a.x, b.x);
  let y1 = Math.max(a.y, b.y);
  if (shape === "square" || shape === "circle") {
    const side = Math.max(x1 - x0, y1 - y0);
    const sx = b.x >= a.x ? 1 : -1;
    const sy = b.y >= a.y ? 1 : -1;
    x0 = Math.min(a.x, a.x + sx * side);
    x1 = Math.max(a.x, a.x + sx * side);
    y0 = Math.min(a.y, a.y + sy * side);
    y1 = Math.max(a.y, a.y + sy * side);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return null; // ignore stray clicks
  if (shape === "rectangle" || shape === "square") {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }
  if (shape === "triangle") {
    return [
      { x: (x0 + x1) / 2, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }
  // ellipse / circle, approximated as a 64-gon
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const points = [];
  const segments = 64;
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

function addInterpolatedStrokePoints(stroke, from, to, spacing) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.floor(distance / spacing));
  for (let index = 1; index <= steps; index++) {
    stroke.points.push({ x: from.x + (dx * index) / steps, y: from.y + (dy * index) / steps });
  }
}

export {
  resizeFogLayer, buildStrokeLayer, rebuildFog, compositeFog, roomPathFog, strokePathFog, polygonCentroid, drawStampDraft,
  drawPolygon, stampPolygon, addInterpolatedStrokePoints,
};
