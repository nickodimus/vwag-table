/* aoe-measure.js — area-of-effect templates, the measure tool, and grid/measure calibration.
 * The DRAW + COMPUTE side: renders the aoe template, the measure line + feet label, and the
 * calibration drag box, and computes the world px per cell. Reads tool state from the hub and
 * coordinates from geometry.js; never triggers render/sync. The orchestration shells that do
 * (finishCalibration, setAoeShape, ...) stay in app.js until the render/input layer at step 14.
 */

import {
  ctx, FEET_PER_CELL, MEASURE_UNITS, controls, state, tools, cur, sel,
} from "./state.js";
import {
  nativeToScreen,
} from "./geometry.js";

const AOE_CONE_HALF_ANGLE = Math.atan(0.5); // ~26.6°, total spread ≈ 53° (D&D cone)

function updateCalibrationUI() {
  controls.gridCalibrate?.classList.toggle("active", tools.calibrating === "grid");
  controls.measureCalibrate?.classList.toggle("active", tools.calibrating === "measure");
}

// The "measure one square" calibration is only offered when the grid overlay is off
// (i.e. the map has its own printed grid to calibrate the ruler against).
function updateMeasureCalibrateRow() {
  controls.measureCalibrateRow?.classList.toggle("hidden", state.grid.enabled);
}

function drawCalibrationDraft() {
  if (!tools.calibrationDraft) return;
  const a = tools.calibrationDraft.start;
  const b = tools.calibrationDraft.end;
  ctx.save();
  ctx.strokeStyle = "#b1c301";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.setLineDash([6 / (cur.k * cur.ms), 4 / (cur.k * cur.ms)]);
  if (tools.calibrating === "scale") {
    // Scale calibration marks a straight line along the printed scale bar (a length, not a cell).
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else {
    const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const sx = b.x >= a.x ? 1 : -1;
    const sy = b.y >= a.y ? 1 : -1;
    const x0 = Math.min(a.x, a.x + sx * side);
    const y0 = Math.min(a.y, a.y + sy * side);
    ctx.fillStyle = "rgba(177, 195, 1, 0.18)";
    ctx.strokeRect(x0, y0, side, side);
    ctx.fillRect(x0, y0, side, side);
  }
  ctx.restore();
}

// Build the AoE outline path (no fill/stroke) at a native position. Shared by the live hover
// template and the committed zones so a dropped shape is pixel-identical to its preview.
function aoePath(x, y, size, shape, angle) {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, size, 0, Math.PI * 2);
  } else if (shape === "square") {
    ctx.rect(x - size / 2, y - size / 2, size, size);
  } else if (shape === "cone") {
    // A real triangle: apex at the origin, two straight edges to a flat far side.
    const a1 = angle - AOE_CONE_HALF_ANGLE;
    const a2 = angle + AOE_CONE_HALF_ANGLE;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a1) * size, y + Math.sin(a1) * size);
    ctx.lineTo(x + Math.cos(a2) * size, y + Math.sin(a2) * size);
    ctx.closePath();
  }
}

// An AoE's on-map size in native px (radius, half-side, or cone length) for a given foot measure.
function aoeSizePx(sizeFt) {
  const pxPerFt = measureCellWorld() / FEET_PER_CELL / (state.map.scale || 1);
  return sizeFt * pxPerFt;
}

// Draw the live AoE hover template at the current cursor position (native coords).
// Visible on both GM and player screens via the view broadcast.
function drawAoeTemplate() {
  if (!tools.aoe.template.visible) return;
  aoePath(tools.aoe.template.x, tools.aoe.template.y, aoeSizePx(tools.aoe.sizeFt), tools.aoe.shape, tools.aoe.angle);
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = tools.aoe.color;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.strokeStyle = tools.aoe.color;
  ctx.stroke();
  ctx.restore();
}

// Committed AoE zones for the active floor — persistent, labeled, and synced to the player. Drawn
// above the fog (like the hover template and stairs) so the table reliably shows where a spell
// landed; the low fill alpha keeps any tokens inside the zone fully visible through the tint. The
// selected zone gets a brighter, thicker outline. Each record carries a reserved `effect` field
// (null today) for a future animated spell visual — an animated-token type will bind there without
// changing this record's shape, so AoEs never become a fourth token kind.
function drawAoes() {
  (state.aoes || []).forEach((a) => {
    aoePath(a.x, a.y, aoeSizePx(a.sizeFt), a.shape, a.angle);
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = a.color;
    ctx.fill();
    const selected = a === sel.aoe;
    ctx.globalAlpha = selected ? 1 : 0.85;
    ctx.lineWidth = (selected ? 3 : 2) / (cur.k * cur.ms);
    ctx.strokeStyle = a.color;
    ctx.stroke();
    ctx.restore();
  });
}

// Screen-space labels for committed zones, so a name like "Fireball" stays legible at any zoom
// (mirrors the measure label). Anchored at the zone's visual center; a cone labels along its axis.
function drawAoeLabels() {
  (state.aoes || []).forEach((a) => {
    if (!a.label) return;
    const size = aoeSizePx(a.sizeFt);
    let ax = a.x, ay = a.y;
    if (a.shape === "cone") { ax = a.x + Math.cos(a.angle) * size * 0.5; ay = a.y + Math.sin(a.angle) * size * 0.5; }
    const p = nativeToScreen({ x: ax, y: ay });
    ctx.save();
    ctx.font = "600 13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(a.label).width + 12;
    ctx.fillStyle = "rgba(12,13,13,0.85)";
    ctx.fillRect(p.x - width / 2, p.y - 10, width, 20);
    ctx.fillStyle = "#f4e8c8";
    ctx.fillText(a.label, p.x, p.y);
    ctx.restore();
  });
}

function pointInTriangle(p, a, b, c) {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Topmost committed AoE under a native point (last drawn = first hit), for select / delete.
function hitAoe(native) {
  const list = state.aoes || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    const size = aoeSizePx(a.sizeFt);
    if (a.shape === "circle") {
      if (Math.hypot(native.x - a.x, native.y - a.y) <= size) return a;
    } else if (a.shape === "square") {
      if (Math.abs(native.x - a.x) <= size / 2 && Math.abs(native.y - a.y) <= size / 2) return a;
    } else if (a.shape === "cone") {
      const a1 = a.angle - AOE_CONE_HALF_ANGLE, a2 = a.angle + AOE_CONE_HALF_ANGLE;
      const apex = { x: a.x, y: a.y };
      const c1 = { x: a.x + Math.cos(a1) * size, y: a.y + Math.sin(a1) * size };
      const c2 = { x: a.x + Math.cos(a2) * size, y: a.y + Math.sin(a2) * size };
      if (pointInTriangle(native, apex, c1, c2)) return a;
    }
  }
  return null;
}

function drawMeasureLine(line = tools.measureLine) {
  if (!line) return;
  ctx.save();
  ctx.strokeStyle = "rgba(214,169,77,0.95)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.setLineDash([8 / (cur.k * cur.ms), 6 / (cur.k * cur.ms)]);
  ctx.beginPath();
  ctx.moveTo(line.start.x, line.start.y);
  ctx.lineTo(line.end.x, line.end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  [line.start, line.end].forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = "#d6a94d";
    ctx.fill();
  });
  ctx.restore();
}

// World px that represent one cell for measurement: the live grid when it's on, else the
// calibrated size (from "measure one square"), else the grid size as a fallback.
function measureCellWorld() {
  if (state.grid.enabled && state.grid.size > 0) return state.grid.size;
  if (state.measure.cellSize > 0) return state.measure.cellSize;
  return state.grid.size > 0 ? state.grid.size : 0;
}

function drawMeasureLabel(line = tools.measureLine) {
  if (!line) return;
  const ms = state.map.scale || 1;
  const dx = (line.end.x - line.start.x) * ms;
  const dy = (line.end.y - line.start.y) * ms;
  const worldDist = Math.hypot(dx, dy);
  let label;
  if (state.measure.unitsPerPx > 0) {
    // Map calibrated to its printed scale bar: show real-world distance only, no cells.
    const dist = worldDist * state.measure.unitsPerPx;
    const dstr = dist >= 100 ? String(Math.round(dist)) : dist.toFixed(1);
    label = `${dstr} ${state.measure.scaleLabel || "km"}`;
  } else {
    const cellW = measureCellWorld();
    const cells = cellW > 0 ? worldDist / cellW : 0;
    const unit = MEASURE_UNITS[state.measure.unit] || MEASURE_UNITS.imperial;
    const dist = cells * unit.perCell;
    const distStr = state.measure.unit === "metric" ? dist.toFixed(1) : String(Math.round(dist));
    label = `${cells.toFixed(1)} cells · ${distStr} ${unit.label}`;
  }
  const mid = nativeToScreen({
    x: (line.start.x + line.end.x) / 2,
    y: (line.start.y + line.end.y) / 2,
  });
  ctx.save();
  ctx.font = "600 13px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padding = 6;
  const width = ctx.measureText(label).width + padding * 2;
  ctx.fillStyle = "rgba(12,13,13,0.85)";
  ctx.fillRect(mid.x - width / 2, mid.y - 24, width, 20);
  ctx.fillStyle = "#f4e8c8";
  ctx.fillText(label, mid.x, mid.y - 14);
  ctx.restore();
}

export {
  drawAoeTemplate, drawAoes, drawAoeLabels, hitAoe, drawMeasureLine, drawMeasureLabel, drawCalibrationDraft, measureCellWorld, updateCalibrationUI, updateMeasureCalibrateRow,
};
