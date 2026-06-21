/* rooms-obstacles.js — room and obstacle rendering + geometry.
 * Draws room outlines, names (wrapped to fit), and the in-progress draft polylines for both rooms
 * and obstacles; answers obstacle hit-tests and the sight-segment collection for movement. Pure
 * draw + compute. The GM edit mutators (finishRoom/finishObstacle/delete/rename) stay in app.js;
 * in-progress draft polylines live in the hub tools object.
 */

import {
  ctx, cur, state, tools,
} from "./state.js";
import {
  distToSegment, gridCellNative, nativeToScreen,
} from "./geometry.js";
import {
  castVersion,
} from "./vision.js";

import {
  drawPolygon, polygonCentroid,
} from "./fog.js";

const OBSTACLE_COLORS = {
  wall: "rgba(214,169,77,0.9)",
  object: "rgba(230,150,90,0.9)",
  door: "rgba(120,200,140,0.95)",
  window: "rgba(120,200,220,0.95)",
  invisible: "rgba(180,150,220,0.85)",
  ethereal: "rgba(190,190,190,0.75)",
};

// Sight-segment cache for movement collision, keyed on the cast version (bumped when obstacles
// or the floor change). Local to moveSegments — rebuilt lazily, reused until the version moves.
let moveSegCache = null;
let moveSegVersion = -1;

function drawRoomOutlines() {
  ctx.save();
  state.fog.rooms.forEach((room) => {
    if (room.revealed) return;
    drawPolygon(room.points);
    ctx.strokeStyle = "rgba(214,169,77,0.72)";
    ctx.lineWidth = 2 / (cur.k * cur.ms);
    ctx.stroke();
  });
  ctx.restore();
}

// GM-only overlay of authored obstacle geometry ("Walls Visible to DM"). Points are in cells;
// convert to native to draw. Invisible obstacles render dashed (no in-world line).
function drawObstacleOutlines() {
  if (!tools.showObstacles || !state.obstacles.length) return;
  ctx.save();
  ctx.lineWidth = 2.5 / (cur.k * cur.ms);
  ctx.lineJoin = "round";
  state.obstacles.forEach((ob) => {
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    if (pts.length < 2) return;
    const openDoor = ob.kind === "door" && ob.open;
    ctx.strokeStyle = openDoor ? "rgba(120,200,140,0.35)" : (OBSTACLE_COLORS[ob.kind] || OBSTACLE_COLORS.wall);
    ctx.setLineDash(ob.drawn === false || openDoor ? [9 / (cur.k * cur.ms), 6 / (cur.k * cur.ms)] : []);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (ob.conceal) ctx.closePath(); // conceal zones are closed boxes, not open wall runs
    ctx.stroke();
  });
  ctx.setLineDash([]);
  ctx.restore();
}

function drawDraftObstacle() {
  if (!tools.drawingObstacle.length) return;
  ctx.save();
  ctx.strokeStyle = OBSTACLE_COLORS[tools.obstacleKind] || OBSTACLE_COLORS.wall;
  ctx.lineWidth = 2.5 / (cur.k * cur.ms);
  ctx.lineJoin = "round";
  if (tools.drawingObstacle.length > 1) {
    ctx.beginPath();
    ctx.moveTo(tools.drawingObstacle[0].x, tools.drawingObstacle[0].y);
    for (let i = 1; i < tools.drawingObstacle.length; i++) ctx.lineTo(tools.drawingObstacle[i].x, tools.drawingObstacle[i].y);
    ctx.stroke();
  }
  tools.drawingObstacle.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = OBSTACLE_COLORS[tools.obstacleKind] || OBSTACLE_COLORS.wall;
    ctx.fill();
  });
  ctx.restore();
}

// Wrap text to maxW screen px (ctx.font must already be set). Hard-breaks words longer than
// the line, and caps at maxLines with an ellipsis so a long name never overflows its label.
function wrapLabel(text, maxW, maxLines) {
  const fits = (s) => ctx.measureText(s).width <= maxW;
  const lines = [];
  let line = "";
  for (let word of String(text).trim().split(/\s+/).filter(Boolean)) {
    while (!fits(word) && word.length > 1) {
      let cut = word.length;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const test = line ? line + " " + word : word;
    if (line && !fits(test)) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && !fits(last + "…")) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  return lines.length ? lines : [""];
}

// GM-only labels ("cartouches") for named fog areas. Drawn in screen space so they stay
// readable at any zoom; long names wrap (up to 3 lines) and truncate instead of overflowing.
// Players never call this, so the names are never shown on the player display.
function drawRoomNames() {
  const named = state.fog.rooms.filter((room) => room.name);
  if (!named.length) return;
  ctx.save();
  ctx.font = "600 13px Inter, ui-sans-serif, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = 200;
  const lh = 16;
  const padX = 7;
  const padY = 5;
  named.forEach((room) => {
    const screen = nativeToScreen(polygonCentroid(room.points));
    const lines = wrapLabel(room.name, maxW, 3);
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = Math.min(maxW, textW) + padX * 2;
    const boxH = lines.length * lh + padY * 2;
    const top = screen.y - boxH / 2;
    ctx.fillStyle = "rgba(8, 9, 9, 0.78)";
    ctx.fillRect(screen.x - boxW / 2, top, boxW, boxH);
    ctx.fillStyle = room.revealed ? "rgba(244, 232, 200, 0.5)" : "#f4e8c8";
    lines.forEach((line, i) => ctx.fillText(line, screen.x, top + padY + lh / 2 + i * lh));
  });
  ctx.restore();
}

function drawDraftRoom() {
  if (!tools.drawingRoom.length) return;
  ctx.save();
  ctx.fillStyle = "rgba(127, 182, 166, 0.18)";
  ctx.strokeStyle = "rgba(127, 182, 166, 0.95)";
  ctx.lineWidth = 2 / (cur.k * cur.ms);
  drawPolygon(tools.drawingRoom);
  if (tools.drawingRoom.length > 2) ctx.fill();
  ctx.stroke();
  tools.drawingRoom.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = "#7fb6a6";
    ctx.fill();
  });
  ctx.restore();
}

// Closed-state behavior flags per kind. Doors block until opened (the session tracks open doors);
// windows and objects are see-through but block movement (window = a drawn pane; object = an
// invisible railing/ledge — pier edges, low hedges, anything you can see over but not cross);
// invisible is a conceal zone: a passable closed box that blocks nothing but ghosts any token
// standing inside it on the player view (the field-to-dungeon "descend out of view" effect).
function obstacleDefaults(kind) {
  switch (kind) {
    case "window":    return { blocksSight: false, blocksLight: false, blocksMove: true, drawn: true, openable: false };
    case "object":    return { blocksSight: false, blocksLight: false, blocksMove: true, drawn: true, openable: false }; // see-through barrier: railings, pier edges, low hedges
    case "door":      return { blocksSight: true, blocksLight: true, blocksMove: true, drawn: true, openable: true };
    case "invisible": return { blocksSight: false, blocksLight: false, blocksMove: false, drawn: false, openable: false, conceal: true }; // conceal zone: passable closed box; ghosts tokens inside it on the player view
    default:          return { blocksSight: true, blocksLight: true, blocksMove: true, drawn: true, openable: false }; // wall/ethereal
  }
}

// The obstacle nearest a native click within a small threshold, or null. Stored points are in
// cells, so convert to native before measuring.
function hitObstacle(native) {
  const threshold = Math.max(10, gridCellNative() / 3);
  let best = null;
  let bestDist = threshold;
  state.obstacles.forEach((ob) => {
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(native, pts[i], pts[i + 1]);
      if (d < bestDist) { bestDist = d; best = ob; }
    }
  });
  return best;
}

function moveSegments() {
  if (moveSegCache && moveSegVersion === castVersion) return moveSegCache;
  const segs = [];
  state.obstacles.forEach((ob) => {
    if (ob.blocksMove === false) return;
    if (ob.kind === "door" && ob.open) return; // open doors let movement through
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
  });
  const w = state.imageWidth || 0;
  const h = state.imageHeight || 0;
  segs.push({ a: { x: 0, y: 0 }, b: { x: w, y: 0 } });
  segs.push({ a: { x: w, y: 0 }, b: { x: w, y: h } });
  segs.push({ a: { x: w, y: h }, b: { x: 0, y: h } });
  segs.push({ a: { x: 0, y: h }, b: { x: 0, y: 0 } });
  moveSegCache = segs;
  moveSegVersion = castVersion;
  return segs;
}

export {
  drawRoomOutlines, drawObstacleOutlines, drawDraftObstacle, wrapLabel, drawRoomNames, drawDraftRoom, obstacleDefaults, hitObstacle,
  moveSegments,
};
