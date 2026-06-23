/* render.js — the canvas frame compositor.
 * render() is the single per-frame orchestrator: it clears, transforms, and paints the board by
 * calling each feature module's draw in z-order, branching GM vs player on isPlayer. Owns the grid,
 * tool previews, splash, stairs, cast-debug, and the GM/player overlay draws. Reads the hub; writes
 * nothing. The frame hook (hooks.render) is wired to this render in app.js after imports.
 */

import {
  STAIRS_ICON_DOWN, STAIRS_ICON_NEUTRAL, STAIRS_ICON_UP, canvas, castCache, castFrameKeys, ctx, cur,
  emptyState, fogBuf, isPlayer, lightCache, lightFrameKeys, sel, state, tools,
  ui,
  scene,
} from "./state.js";
import {
  clientToCanvasPoint, currentViewRotation, gridCellNative, keepUpright, nativeToScreen, screenToNative, viewTransform, worldDims,
} from "./geometry.js";
import {
  compositeLoS, compositeLightTint, drawLights, getVisibilityPolygon,
} from "./vision.js";
import {
  drawTokens,
} from "./tokens.js";
import {
  compositeFog, drawStampDraft, rebuildFog,
} from "./fog.js";
import {
  drawImages, drawNotes, drawPings,
} from "./annotations.js";
import {
  drawDraftObstacle, drawDraftRoom, drawObstacleOutlines, drawRoomNames, drawRoomOutlines,
} from "./rooms-obstacles.js";
import {
  drawAoeTemplate, drawAoes, drawAoeLabels, drawCalibrationDraft, drawMeasureLabel, drawMeasureLine,
} from "./aoe-measure.js";

function drawStairs() {
  if (!state.stairs.length) return;

  const myIdx = !isPlayer && state.floors
    ? state.floors.findIndex((f) => f.id === state.currentFloorId)
    : -1;

  // Marker fills exactly one grid cell — scales with grid size AND zoom, just like tokens.
  const cell = gridCellNative();
  const half = cell / 2;
  // Constant 2px screen line width regardless of zoom.
  const sw = 2 / (cur.k * cur.ms);

  ctx.save();
  const rot = currentViewRotation();

  state.stairs.forEach((stair) => {
    const { x, y } = stair;
    ctx.save();
    keepUpright(x, y, rot); // icon + label stay upright when the map is rotated

    // Determine direction: 1 = going UP (target floor has a higher index), -1 = DOWN.
    let dir = 0;
    if (!isPlayer && myIdx !== -1 && state.floors) {
      const targetIdx = state.floors.findIndex((f) => f.id === stair.targetFloorId);
      if (targetIdx !== -1) dir = targetIdx > myIdx ? 1 : -1;
    }

    // ---- bare stair icon (no box/background) in the tunable stair color ----
    // The Tabler icons are defined in a 24×24 coordinate space; fill ~90% of the cell.
    const stairColor = state.stairColor || "#ffffff";
    const iconFill = cell * 0.90;
    const iconScale = iconFill / 24;
    const iconPad = (cell - iconFill) / 2;

    ctx.save();
    ctx.translate(x - half + iconPad, y - half + iconPad);
    ctx.scale(iconScale, iconScale);
    ctx.strokeStyle = stairColor;
    ctx.lineWidth = 2.4 / (cur.k * cur.ms * iconScale); // stays a constant width on screen
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const icon = dir > 0 ? STAIRS_ICON_UP : dir < 0 ? STAIRS_ICON_DOWN : STAIRS_ICON_NEUTRAL;
    ctx.stroke(icon);
    ctx.restore();

    // ---- optional text label below the square ----
    if (stair.label) {
      ctx.save();
      ctx.font = `600 ${Math.round(half * 0.65)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#f4e8c8";
      ctx.fillText(stair.label, x, y + half + sw * 2);
      ctx.restore();
    }

    // ---- hover highlight outline in stair placement mode (GM only) ----
    if (!isPlayer && ui.mode === "stair") {
      const gap = sw * 3;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - half - gap, y - half - gap, cell + gap * 2, cell + gap * 2);
      ctx.strokeStyle = "rgba(177,195,1,0.50)";
      ctx.lineWidth = sw * 1.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  });

  ctx.restore();
}

// Drop cached visibility polygons that weren't touched last frame. The frame-key sets are populated
// as each origin is cast; anything in the cache but not in that set belongs to a stale origin (a
// token's previous position, a removed light) and would otherwise live forever — the caches are
// only otherwise cleared by invalidateCast(), which now fires solely on real geometry changes. This
// keeps each cache bounded to the live origins (player tokens + on-floor lights).
function evictUnusedCast(cache, usedKeys) {
  for (const key of cache.keys()) if (!usedKeys.has(key)) cache.delete(key);
}

function render() {
  const rect = canvas.getBoundingClientRect();
  // Evict last frame's stale cast entries, then reset the tally for this frame.
  evictUnusedCast(castCache, castFrameKeys);
  evictUnusedCast(lightCache, lightFrameKeys);
  castFrameKeys.clear();
  lightFrameKeys.clear();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#080909";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (isPlayer && state.blackout) {
    emptyState.classList.add("hidden");
    return;
  }
  if (isPlayer && state.splash.enabled) {
    renderSplash(rect);
    return;
  }

  emptyState.classList.toggle("hidden", Boolean(state.imageData));
  if (!state.imageData || !scene.map.complete) return;

  const t = viewTransform();
  cur.k = t.k;
  cur.ms = t.ms;
  const { w, h } = worldDims();

  ctx.save();
  // Center the view, rotate, scale, then shift so (cx,cy) sits at the canvas center.
  ctx.translate(t.centerX, t.centerY);
  ctx.rotate(t.rot);
  ctx.scale(t.k, t.k);
  ctx.translate(-t.cx * t.ms, -t.cy * t.ms);

  // World block (native x map.scale)
  ctx.drawImage(scene.map, 0, 0, w, h);
  if (state.grid.enabled) drawGrid(w, h);

  // Native block
  ctx.save();
  ctx.scale(t.ms, t.ms);
  if (fogBuf.dirty) rebuildFog();
  // Images and tokens sit BELOW the fog so anything in an unrevealed area is hidden (solid
  // black for players, dimmed under the GM tint).
  drawImages();
  compositeLightTint(); // 5e: colored-light glow over the map, beneath tokens (GM + player)
  drawTokens();
  compositeFog();
  if (isPlayer && state.los.enabled) compositeLoS();
  drawAoes(); // committed zones, above fog so the table reliably shows where a spell landed
  drawAoeTemplate(); // hover template sits above fog; visible to both GM and player
  if (!isPlayer) drawRoomOutlines();
  if (!isPlayer) drawObstacleOutlines();
  if (!isPlayer) drawLights();
  if (!isPlayer) drawCastDebug();
  drawStairs(); // GM and player alike, above fog — players need to see a stair to stand on it (show-all for now; FoW-gating is a later refinement)
  if (!isPlayer) drawDraftRoom();
  if (!isPlayer) drawDraftObstacle();
  if (!isPlayer) drawStampDraft();
  if (!isPlayer) drawCalibrationDraft();
  if (tools.measureLine) drawMeasureLine();
  if (tools.dragMeasureLine) drawMeasureLine(tools.dragMeasureLine);
  if (!isPlayer && ["brush", "eraser"].includes(ui.mode) && state.imageData) {
    drawToolPreview(screenToNative(clientToCanvasPoint(ui.lastPointer)));
  }
  ctx.restore();

  ctx.restore();

  // Screen-space overlays
  drawPings();
  drawAoeLabels(); // committed-zone names, screen-space so they stay legible at any zoom
  if (tools.measureLine) drawMeasureLabel();
  if (tools.dragMeasureLine) drawMeasureLabel(tools.dragMeasureLine);
  if (!isPlayer) drawRoomNames();
  if (!isPlayer) drawNotes();
  if (!isPlayer) drawPlayerFrame();
  if (isPlayer && sel.marquee) drawPlayerMarquee();

  // Keep the caches bounded to origins actually used this frame (~live token + light count).
  for (const k of castCache.keys()) if (!castFrameKeys.has(k)) castCache.delete(k);
  for (const k of lightCache.keys()) if (!lightFrameKeys.has(k)) lightCache.delete(k);
}

// GM-only: a red rectangle marking the region the player display currently shows, so the
// GM can tell exactly what their players see. Uses the player's reported pixel size.
// Screen-space corners of the player's visible region, or null when no frame is shown.
// Un-rotates by the player's own rotation, then projects through the GM transform, so the
// frame is correct even when the GM and player views are rotated differently.
function playerFrameCorners() {
  if (!ui.showPlayerFrame || !ui.playerViewport || !state.imageData) return null;
  const ms = state.map.scale || 1;
  const pv = state.playerView.matchDM ? state.view : state.playerView;
  if (!pv.scale) return null;
  const s = pv.scale * ms;
  const hw = ui.playerViewport.w / 2;
  const hh = ui.playerViewport.h / 2;
  const pr = ((pv.rotation || 0) * Math.PI) / 180;
  const cosP = Math.cos(-pr);
  const sinP = Math.sin(-pr);
  const toNative = (ox, oy) => ({
    x: pv.cx + (ox * cosP - oy * sinP) / s,
    y: pv.cy + (ox * sinP + oy * cosP) / s,
  });
  return [
    nativeToScreen(toNative(-hw, -hh)),
    nativeToScreen(toNative(hw, -hh)),
    nativeToScreen(toNative(hw, hh)),
    nativeToScreen(toNative(-hw, hh)),
  ];
}

function drawPlayerFrame() {
  const corners = playerFrameCorners();
  if (!corners) return;
  ctx.save();
  ctx.globalAlpha = ui.playerFrameOpacity;
  ctx.strokeStyle = ui.playerFrameColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function renderSplash(rect) {
  emptyState.classList.add("hidden");
  if (!state.splash.imageData || !scene.splash.complete) {
    ctx.fillStyle = "#080909";
    ctx.fillRect(0, 0, rect.width, rect.height);
    return;
  }
  const scale = Math.min(rect.width / scene.splash.naturalWidth, rect.height / scene.splash.naturalHeight);
  const width = scene.splash.naturalWidth * scale;
  const height = scene.splash.naturalHeight * scale;
  ctx.drawImage(scene.splash, (rect.width - width) / 2, (rect.height - height) / 2, width, height);
}

function drawGrid(worldW, worldH) {
  const size = state.grid.size;
  if (size <= 0) return;
  ctx.save();
  ctx.globalAlpha = state.grid.opacity;
  ctx.strokeStyle = state.grid.color;
  ctx.lineWidth = 1 / cur.k;
  ctx.beginPath();
  const startX = ((state.grid.offsetX % size) + size) % size;
  const startY = ((state.grid.offsetY % size) + size) % size;
  for (let x = startX; x <= worldW; x += size) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, worldH);
  }
  for (let y = startY; y <= worldH; y += size) {
    ctx.moveTo(0, y);
    ctx.lineTo(worldW, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawToolPreview(point) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ui.mode === "eraser" ? "rgba(214,106,95,0.95)" : "rgba(127,182,166,0.95)";
  ctx.fillStyle = ui.mode === "eraser" ? "rgba(214,106,95,0.12)" : "rgba(127,182,166,0.12)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  drawToolShapePath(point, state.fog.toolSize, state.fog.toolShape);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawToolShapePath(point, size, shape) {
  const radius = size / 2;
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(point.x - radius, point.y - radius, size, size);
  } else {
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
}

// Draw the rubber-band box in screen space (canvas px), matching the cyan selection accent.
function drawPlayerMarquee() {
  const m = sel.marquee;
  if (!m) return;
  const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
  ctx.save();
  ctx.fillStyle = "rgba(58,210,230,0.12)";
  ctx.strokeStyle = "#3ad2e6";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// GM-only debug overlay: when castDebug is on and a token is selected, fill + outline the
// visibility polygon cast from that token so the engine can be eyeballed (walls occlude,
// windows pass, corners peek) before any consumer is wired up. Drawn in the Native block.
function drawCastDebug() {
  if (isPlayer || !ui.castDebug || !sel.token || !state.imageData) return;
  const poly = getVisibilityPolygon({ x: sel.token.x, y: sel.token.y });
  if (poly.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(120, 220, 255, 0.16)";
  ctx.fill();
  ctx.lineWidth = 1.5 / (cur.k * cur.ms);
  ctx.strokeStyle = "rgba(120, 220, 255, 0.85)";
  ctx.stroke();
  // Mark the cast origin.
  ctx.beginPath();
  ctx.arc(sel.token.x, sel.token.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(120, 220, 255, 0.95)";
  ctx.fill();
  ctx.restore();
}

export {
  render, drawGrid, drawToolPreview, drawToolShapePath, renderSplash, drawCastDebug, drawPlayerFrame, drawPlayerMarquee,
  drawStairs, playerFrameCorners,
};
