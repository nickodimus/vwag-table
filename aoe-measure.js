/* aoe-measure.js — area-of-effect templates, the measure tool, and grid/measure calibration.
 * The DRAW + COMPUTE side: renders the aoe template, the measure line + feet label, and the
 * calibration drag box, and computes the world px per cell. Reads tool state from the hub and
 * coordinates from geometry.js; never triggers render/sync. The orchestration shells that do
 * (finishCalibration, setAoeShape, ...) stay in app.js until the render/input layer at step 14.
 */

import {
  ctx, FEET_PER_CELL, MEASURE_UNITS, controls, state, tools, cur,
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
  const ms = state.map.scale || 1;
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const sx = b.x >= a.x ? 1 : -1;
  const sy = b.y >= a.y ? 1 : -1;
  const x0 = Math.min(a.x, a.x + sx * side);
  const y0 = Math.min(a.y, a.y + sy * side);
  ctx.save();
  ctx.fillStyle = "rgba(177, 195, 1, 0.18)";
  ctx.strokeStyle = "#b1c301";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.setLineDash([6 / (cur.k * cur.ms), 4 / (cur.k * cur.ms)]);
  ctx.strokeRect(x0, y0, side, side);
  ctx.fillRect(x0, y0, side, side);
  ctx.restore();
}

// Draw the live AoE hover template at the current cursor position (native coords).
// Visible on both GM and player screens via the view broadcast.
function drawAoeTemplate() {
  if (!tools.aoe.template.visible) return;
  const x = tools.aoe.template.x;
  const y = tools.aoe.template.y;
  const pxPerFt = measureCellWorld() / FEET_PER_CELL / (state.map.scale || 1);
  const size = tools.aoe.sizeFt * pxPerFt; // size in native px (radius, half-side, or cone length)

  ctx.save();
  ctx.beginPath();
  if (tools.aoe.shape === "circle") {
    ctx.arc(x, y, size, 0, Math.PI * 2);
  } else if (tools.aoe.shape === "square") {
    ctx.rect(x - size / 2, y - size / 2, size, size);
  } else if (tools.aoe.shape === "cone") {
    // A real triangle: apex at the cursor, two straight edges to a flat far side.
    const a1 = tools.aoe.angle - AOE_CONE_HALF_ANGLE;
    const a2 = tools.aoe.angle + AOE_CONE_HALF_ANGLE;
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a1) * size, y + Math.sin(a1) * size);
    ctx.lineTo(x + Math.cos(a2) * size, y + Math.sin(a2) * size);
    ctx.closePath();
  }
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = tools.aoe.color;
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.strokeStyle = tools.aoe.color;
  ctx.stroke();
  ctx.restore();
}

function drawMeasureLine() {
  ctx.save();
  ctx.strokeStyle = "rgba(214,169,77,0.95)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  ctx.setLineDash([8 / (cur.k * cur.ms), 6 / (cur.k * cur.ms)]);
  ctx.beginPath();
  ctx.moveTo(tools.measureLine.start.x, tools.measureLine.start.y);
  ctx.lineTo(tools.measureLine.end.x, tools.measureLine.end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  [tools.measureLine.start, tools.measureLine.end].forEach((p) => {
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

function drawMeasureLabel() {
  const ms = state.map.scale || 1;
  const dx = (tools.measureLine.end.x - tools.measureLine.start.x) * ms;
  const dy = (tools.measureLine.end.y - tools.measureLine.start.y) * ms;
  const worldDist = Math.hypot(dx, dy);
  const cellW = measureCellWorld();
  const cells = cellW > 0 ? worldDist / cellW : 0;
  const unit = MEASURE_UNITS[state.measure.unit] || MEASURE_UNITS.imperial;
  const dist = cells * unit.perCell;
  const distStr = state.measure.unit === "metric" ? dist.toFixed(1) : String(Math.round(dist));
  const label = `${cells.toFixed(1)} cells · ${distStr} ${unit.label}`;
  const mid = nativeToScreen({
    x: (tools.measureLine.start.x + tools.measureLine.end.x) / 2,
    y: (tools.measureLine.start.y + tools.measureLine.end.y) / 2,
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
  drawAoeTemplate, drawMeasureLine, drawMeasureLabel, drawCalibrationDraft, measureCellWorld, updateCalibrationUI, updateMeasureCalibrateRow,
};
