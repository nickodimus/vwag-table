/* tokens.js — token rendering layer.
 * Draws every token on the board: the image or fallback disc, the type ring, the name label, the
 * selection outline, and the active-turn ring (deferred here from initiative). Pure draw — reads
 * state + the selection (sel.token) + the render-scale cache, paints. Token mutators, hit-testing,
 * the image-load UI, and DTT token import stay in app.js.
 */

import {
  CONDITIONS, EXHAUSTION_ICON, ctx, cur, isPlayer, sel, state,
} from "./state.js";
import {
  currentViewRotation, gridCellNative, keepUpright, tokenRadius, pointInPolygon,
} from "./geometry.js";
import {
  getTokenImage,
} from "./annotations.js";
import {
  activeTurnTokenId,
} from "./initiative.js";
import {
  playerVisionPolygons,
} from "./vision.js";

const TOKEN_TYPE_RING = { player: "#3fb950", npc: "#539bf5", monster: "#e5534b" };

// Multi-cell tokens render as squares (they fill their grid footprint); single-cell
// tokens stay circular.
function tokenIsSquare(token) {
  return (token.cells || 1) > 1;
}

function tokenOutline(token, r) {
  if (tokenIsSquare(token)) {
    ctx.rect(token.x - r, token.y - r, r * 2, r * 2);
  } else {
    ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
  }
}

// A colored ring just outside a token's outline indicating its type. Drawn for every token
// on both the GM and player views. Tokens from before typing existed default to monster.
function drawTokenTypeRing(token, r) {
  const color = TOKEN_TYPE_RING[token.type] || TOKEN_TYPE_RING.monster;
  ctx.beginPath();
  tokenOutline(token, r + 1.5 / (cur.k * cur.ms));
  ctx.lineWidth = Math.max(1.5, 2.5 / (cur.k * cur.ms));
  ctx.strokeStyle = color;
  ctx.stroke();
}

// Draw a token's label centered in the token, auto-shrinking the font so the whole label
// fits inside the token (down to a floor), with a light outline so it stays legible over
// token art as well as flat color.
function drawTokenLabel(token, r, below) {
  const text = String(token.label);
  if (!text) return;
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  // Centered labels must fit inside the token; labels below have lateral room to breathe.
  const maxWidth = below ? r * 2.4 : r * 1.7;
  let fontPx = Math.round(gridCellNative() / 2);
  ctx.font = `700 ${fontPx}px Inter, sans-serif`;
  while (fontPx > 6 && ctx.measureText(text).width > maxWidth) {
    fontPx -= 1;
    ctx.font = `700 ${fontPx}px Inter, sans-serif`;
  }
  let y = token.y;
  if (below) {
    // Sit just under the type ring so the art stays clear and the name is readable.
    ctx.textBaseline = "top";
    y = token.y + r + 4 / (cur.k * cur.ms);
  } else {
    ctx.textBaseline = "middle";
  }
  ctx.lineWidth = Math.max(1, fontPx / 6);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(text, token.x, y);
  ctx.fillStyle = "#0c0d0d";
  ctx.fillText(text, token.x, y);
}

// Bright "whose turn it is" ring, drawn outermost on the active combatant's token on both
// the GM and player views. Static (no animation) to stay light on the off-grid power budget.
function drawActiveTurnRing(token, r) {
  ctx.beginPath();
  tokenOutline(token, r + 3.5 / (cur.k * cur.ms));
  ctx.lineWidth = Math.max(2, 4 / (cur.k * cur.ms));
  ctx.strokeStyle = "#ffd24a";
  ctx.stroke();
}

// Status markers (5e): id -> registry entry, and a Path2D cache (glyphs are static, built once).
const CONDITION_BY_ID = new Map(CONDITIONS.map((c) => [c.id, c]));
const conditionPaths = new Map();
function conditionPath(d) {
  let p = conditionPaths.get(d);
  if (!p) { p = new Path2D(d); conditionPaths.set(d, p); }
  return p;
}

// The status layer for a token: a dead/down red X over the art, then a centered row of condition
// marker badges in the margin ABOVE the footprint (so a physical mini on the cell doesn't hide
// them). Each badge is a dark chip with the condition's 24x24 glyph; exhaustion shows its level as a
// numeral. Sizes scale with the grid like tokens; stroke widths stay screen-constant. Drawn upright
// (the caller applied keepUpright) on both GM and player views, since conditions are shared info.
function drawTokenStatus(token, r) {
  const sw = 1 / (cur.k * cur.ms);

  if (token.down) {
    ctx.save();
    ctx.strokeStyle = "#e24b4a";
    ctx.lineWidth = Math.max(2.5, 5 * sw);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(token.x - r * 0.78, token.y - r * 0.78);
    ctx.lineTo(token.x + r * 0.78, token.y + r * 0.78);
    ctx.moveTo(token.x + r * 0.78, token.y - r * 0.78);
    ctx.lineTo(token.x - r * 0.78, token.y + r * 0.78);
    ctx.stroke();
    ctx.restore();
  }

  const markers = (token.conditions || [])
    .filter((id) => CONDITION_BY_ID.has(id))
    .map((id) => CONDITION_BY_ID.get(id));
  const exh = Math.max(0, Math.min(6, token.exhaustion || 0));
  if (exh > 0) markers.push({ ...EXHAUSTION_ICON, level: exh });
  if (!markers.length) return;

  const cell = gridCellNative();
  const badge = cell * 0.4;        // diameter; scales with the grid like tokens
  const gap = badge * 0.16;
  const pitch = badge + gap;
  const totalW = markers.length * pitch - gap;
  const cy = token.y - r - badge * 0.7;   // sit just above the footprint
  let x = token.x - totalW / 2 + badge / 2;

  markers.forEach((m) => {
    ctx.beginPath();
    ctx.arc(x, cy, badge / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,22,24,0.9)";
    ctx.fill();
    ctx.lineWidth = 1.2 * sw;
    ctx.strokeStyle = m.color;
    ctx.stroke();

    const g = badge * 0.62;
    const s = g / 24;
    ctx.save();
    ctx.translate(x - g / 2, cy - g / 2);
    ctx.scale(s, s);
    ctx.lineWidth = (1.8 / s) * sw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = m.color;
    ctx.stroke(conditionPath(m.d));
    ctx.restore();

    if (m.level) {
      ctx.save();
      ctx.font = `700 ${Math.round(badge * 0.44)}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(1, 2 * sw);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "#ffffff";
      const nx = x + badge * 0.32, ny = cy + badge * 0.32;
      ctx.strokeText(String(m.level), nx, ny);
      ctx.fillText(String(m.level), nx, ny);
      ctx.restore();
    }
    x += pitch;
  });
}

function drawTokens() {
  const lineW = Math.max(1, 2 / (cur.k * cur.ms));
  const rot = currentViewRotation();
  const activeTokenId = activeTurnTokenId();
  // Player screen with line-of-sight on: creatures are only drawn when they sit inside the party's
  // live vision. The map itself stays dim-remembered through explored memory, but a creature must not
  // linger on a remembered-but-now-occluded tile (e.g. after a wall drops between it and the party).
  // Player/party tokens always draw — you can see your own party on the board.
  const visionPolys = isPlayer && state.los.enabled ? playerVisionPolygons() : null;
  state.tokens.forEach((token) => {
    if (
      visionPolys &&
      token.type !== "player" &&
      !visionPolys.some((poly) => pointInPolygon({ x: token.x, y: token.y }, poly))
    ) {
      return; // occluded creature — not currently visible to the party, so skip on the player view
    }
    const r = tokenRadius(token);
    ctx.save();
    keepUpright(token.x, token.y, rot); // art + label stay upright when the map is rotated
    // Conceal zones (invisible obstacles): on the player view, a token whose center sits inside one
    // fades to a faint ghost — it's "descending out of view" — while staying selectable/steerable.
    // The GM always draws tokens full, so the table-runner never loses track of anyone.
    const concealed = isPlayer && state.obstacles.some(
      (o) => o.conceal && o.points && o.points.length >= 3 &&
        pointInPolygon({ x: token.x, y: token.y }, o.points.map((p) => ({ x: p[0], y: p[1] }))),
    );
    const baseAlpha = concealed ? 0.3 : 1;
    ctx.globalAlpha = baseAlpha;
    const img = getTokenImage(token.image);
    if (img && img.complete && img.naturalWidth) {
      // Token art: cover-fit the image into the token outline and ring it.
      ctx.save();
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.clip();
      const scale = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, token.x - w / 2, token.y - h / 2, w, h);
      ctx.restore();
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.lineWidth = lineW;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();
      if (token.label) drawTokenLabel(token, r, true);
    } else {
      ctx.beginPath();
      tokenOutline(token, r);
      ctx.fillStyle = token.color || "#d6a94d";
      ctx.globalAlpha = baseAlpha * 0.95;
      ctx.fill();
      ctx.globalAlpha = baseAlpha;
      ctx.lineWidth = lineW;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.stroke();
      if (token.label) drawTokenLabel(token, r, false);
    }
    drawTokenTypeRing(token, r);
    // Selection highlight (GM only): an accent outline around the active token.
    if (!isPlayer && token === sel.token) {
      ctx.beginPath();
      tokenOutline(token, r + 3 / (cur.k * cur.ms));
      ctx.lineWidth = Math.max(1.5, 3 / (cur.k * cur.ms));
      ctx.strokeStyle = "#b1c301";
      ctx.stroke();
    }
    // Selection highlight (player screen): a cyan outline on every selected token — the targets of
    // arrow-key movement.
    if (isPlayer && sel.playerTokens.includes(token)) {
      ctx.beginPath();
      tokenOutline(token, r + 3 / (cur.k * cur.ms));
      ctx.lineWidth = Math.max(1.5, 3 / (cur.k * cur.ms));
      ctx.strokeStyle = "#3ad2e6";
      ctx.stroke();
    }
    if (token.id === activeTokenId) drawActiveTurnRing(token, r);
    drawTokenStatus(token, r);
    ctx.restore();
  });
}

export {
  tokenIsSquare, tokenOutline, drawTokenTypeRing, drawTokenLabel, drawActiveTurnRing, drawTokens,
};
