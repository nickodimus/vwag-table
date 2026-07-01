/* token-arrows.js — on-canvas octant step arrows for the selected token.
 *
 * A leaf module (same pattern as image-handles/sandbox/shortcuts): pure screen-space draw + hit-test
 * for eight pop-out direction arrows that ring the selected token, so a token can be stepped one
 * grid cell — including diagonals — by finger on the touch table, with no keyboard and no wheel. The
 * ACTION on a hit (the wall-aware step + commit) lives in main.js, which owns resolveMove /
 * pushHistory / relay; this module only answers "where are the arrows" and "did this tap land on one".
 *
 * Anchor:
 *   GM     — the selected token (sel.token) while in pan/move mode.
 *   Player — the single selected player token (exactly one). A multi-select group keeps the fixed
 *            d-pad, which steps the whole formation together; the per-token arrows are the single-
 *            token convenience that also adds the four diagonals.
 *
 * Directions are projected through nativeToScreen, so the ring stays truthful when the map is
 * rotated: each arrow sits in the screen direction the token will actually travel, at a constant
 * screen radius so it is always the same finger-sized target regardless of zoom.
 */

import { ctx, cur, sel, isPlayer, ui } from "./state.js";
import { nativeToScreen, gridCellNative, tokenRadius } from "./geometry.js";

// Native grid deltas for the eight octants, keyed by compass id. main.js maps a hit's id back to
// the same delta to perform the step, so draw, hit-test, and movement never disagree.
const STEP_DIRS = [
  { id: "N",  dx: 0,  dy: -1 },
  { id: "NE", dx: 1,  dy: -1 },
  { id: "E",  dx: 1,  dy: 0 },
  { id: "SE", dx: 1,  dy: 1 },
  { id: "S",  dx: 0,  dy: 1 },
  { id: "SW", dx: -1, dy: 1 },
  { id: "W",  dx: -1, dy: 0 },
  { id: "NW", dx: -1, dy: -1 },
];

const RING_GAP = 18; // screen px from the token's edge out to the arrow centers
const HIT_R = 17;     // screen-px tap radius around each arrow center

// The token the arrows currently ring, or null when they should not show. Centralized so the draw,
// the hit-test, and main.js's step action all agree on the anchor.
function arrowAnchorToken() {
  if (isPlayer) return sel.playerTokens.length === 1 ? sel.playerTokens[0] : null;
  return ui.mode === "pan" && sel.token ? sel.token : null;
}

// Screen positions + ids for the eight arrows around `token`. Direction comes from projecting a
// one-cell native step through the view transform (rotation-correct); magnitude is a fixed screen
// radius (a constant finger target). Shared by the draw and the hit-test so they can never drift.
function stepArrowTargets(token) {
  if (!token) return [];
  const center = nativeToScreen({ x: token.x, y: token.y });
  const step = gridCellNative() || 1;
  const ringR = tokenRadius(token) * cur.k * cur.ms + RING_GAP;
  const out = [];
  for (const d of STEP_DIRS) {
    const off = nativeToScreen({ x: token.x + d.dx * step, y: token.y + d.dy * step });
    const ang = Math.atan2(off.y - center.y, off.x - center.x);
    out.push({ id: d.id, ang, x: center.x + Math.cos(ang) * ringR, y: center.y + Math.sin(ang) * ringR });
  }
  return out;
}

// Draw the eight arrows in screen space (called from render.js after ctx is restored to identity).
// A dark disc for hittability and contrast, then a light chevron pointing outward along the travel
// direction. Flat fills only — no glow or shadow — to stay light on the off-grid power budget.
function drawTokenStepArrows() {
  const token = arrowAnchorToken();
  if (!token) return;
  ctx.save();
  for (const t of stepArrowTargets(token)) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(16,18,20,0.78)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.stroke();

    // Chevron pointing outward along t.ang, centered on the disc.
    const c = Math.cos(t.ang), s = Math.sin(t.ang);
    const px = -s, py = c;     // unit perpendicular
    const bx = t.x - c * 2, by = t.y - s * 2;
    const tip = 6, half = 5;   // tip reach + half-spread, screen px
    ctx.beginPath();
    ctx.moveTo(bx + c * tip, by + s * tip);                     // tip
    ctx.lineTo(bx - c * 2 + px * half, by - s * 2 + py * half); // back corner
    ctx.lineTo(bx - c * 2 - px * half, by - s * 2 - py * half); // back corner
    ctx.closePath();
    ctx.fillStyle = "rgba(238,241,239,0.95)";
    ctx.fill();
  }
  ctx.restore();
}

// Hit-test a canvas screen point against the arrow ring. Returns the direction id (e.g. "NE") or
// null. main.js calls this first in onPointerDown so a tap on an arrow steps instead of selecting.
function hitTokenStepArrow(screenPt) {
  const token = arrowAnchorToken();
  if (!token || !screenPt) return null;
  let best = null, bestD = HIT_R * HIT_R;
  for (const t of stepArrowTargets(token)) {
    const dx = screenPt.x - t.x, dy = screenPt.y - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD) { bestD = d2; best = t.id; }
  }
  return best;
}

export { drawTokenStepArrows, hitTokenStepArrow, arrowAnchorToken };
