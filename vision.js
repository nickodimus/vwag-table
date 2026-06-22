/* vision.js — line-of-sight raycaster, light coverage, and darkness compositing.
 * Casts visibility polygons from player tokens against sight segments (cached by castVersion),
 * unions light sources into the light layer, paints explored memory, and composites LoS + darkness
 * over the view. Pure compute + raster. The light mutator (addLight), the radius control, the
 * obstacle readers, and the GM debug overlay (drawCastDebug, which reads the selection let) stay in
 * app.js. castVersion is owned here (only invalidateCast bumps it) and exported read-only.
 */

import {
  canvas, castCache, castFrameKeys, ctx, cur, darkCanvas, darkCtx, exploredMasks,
  fogBuf, isPlayer, lightCache, lightCanvas, lightCtx, lightFrameKeys, losCanvas, losCtx,
  state, tintCanvas, tintCtx,
} from "./state.js";
import {
  pxPerCellNative,
} from "./geometry.js";

let castVersion = 0; // bumps when sight obstacles or the active floor change, invalidating the cast cache
const LIGHT_BRIGHT_FRACTION = 0.5; // inner radius (fraction of outer) held at full brightness before falloff
const LIGHT_DEFAULT_COLOR = "#ffd9a0"; // warm torch — used for lights/torches authored before 5e (no color field)
const LIGHT_TINT_CORE_ALPHA = 0.55; // additive tint strength at the bright core; fades to 0 at the rim

// Parse a #rgb or #rrggbb hex into an rgba() string at the given alpha. Falls back to the warm
// default for anything unparseable, so an old or malformed light still glows rather than vanishing.
function hexToRgba(hex, a) {
  let h = String(hex || LIGHT_DEFAULT_COLOR).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = LIGHT_DEFAULT_COLOR.replace("#", "");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Call whenever sight obstacles or the active floor change, so the next cast rebuilds.
function invalidateCast() {
  castVersion++;
  castCache.clear();
  lightCache.clear();
}

// Native-space segments that block sight on the current floor: every consecutive pair of
// an obstacle polyline (open, like the renderer) where blocksSight isn't false (windows
// pass through), plus the four map-edge segments so rays that hit nothing terminate at the
// boundary and the visibility polygon stays bounded.
function sightSegments() {
  const segs = [];
  state.obstacles.forEach((ob) => {
    if (ob.blocksSight === false) return; // windows let sight through
    if (ob.kind === "door" && ob.open) return; // open doors let sight through
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
  });
  const w = state.imageWidth || 0;
  const h = state.imageHeight || 0;
  segs.push({ a: { x: 0, y: 0 }, b: { x: w, y: 0 } });
  segs.push({ a: { x: w, y: 0 }, b: { x: w, y: h } });
  segs.push({ a: { x: w, y: h }, b: { x: 0, y: h } });
  segs.push({ a: { x: 0, y: h }, b: { x: 0, y: 0 } });
  return segs;
}

// Nearest hit of a ray (origin + t*dir, t>=0) against a segment. Returns { t, x, y } or null.
// Solves origin + t*dir = a + u*(b-a) for t>=0 and u in [0,1].
function rayHit(origin, dir, seg) {
  const sdx = seg.b.x - seg.a.x;
  const sdy = seg.b.y - seg.a.y;
  const denom = dir.x * sdy - dir.y * sdx;
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const t = ((seg.a.x - origin.x) * sdy - (seg.a.y - origin.y) * sdx) / denom;
  const u = ((seg.a.x - origin.x) * dir.y - (seg.a.y - origin.y) * dir.x) / denom;
  if (t < 1e-6 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, x: origin.x + dir.x * t, y: origin.y + dir.y * t };
}

// Compute the visibility polygon from `origin` (native) against `segments`. Casts three rays
// at each segment endpoint (its angle and +/- a tiny epsilon) so the polygon peeks just past
// corners to the wall behind, then sorts the nearest hits by angle into a closed fan.
function castVisibility(origin, segments) {
  const EPS = 1e-4;
  const angles = [];
  segments.forEach((s) => {
    [s.a, s.b].forEach((p) => {
      const base = Math.atan2(p.y - origin.y, p.x - origin.x);
      angles.push(base - EPS, base, base + EPS);
    });
  });
  const hits = [];
  angles.forEach((ang) => {
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };
    let best = null;
    for (const seg of segments) {
      const h = rayHit(origin, dir, seg);
      if (h && (!best || h.t < best.t)) best = h;
    }
    if (best) hits.push({ x: best.x, y: best.y, ang: Math.atan2(best.y - origin.y, best.x - origin.x) });
  });
  hits.sort((p, q) => p.ang - q.ang);
  return hits;
}

// Cached accessor: returns the visibility polygon for `origin`, recomputing only when the
// origin (rounded to 1px) or the sight geometry (castVersion) has changed since last time.
// Registers the key as used this frame so render() can prune the cache to live origins.
function getVisibilityPolygon(origin) {
  const key = castVersion + "|" + Math.round(origin.x) + "|" + Math.round(origin.y);
  castFrameKeys.add(key);
  const cached = castCache.get(key);
  if (cached) return cached;
  const polygon = castVisibility(origin, sightSegments());
  castCache.set(key, polygon);
  return polygon;
}

// LoS (5b): one visibility polygon per player-type token — the players' shared field of view.
function playerVisionPolygons() {
  const polys = [];
  state.tokens.forEach((t) => {
    if (t.type !== "player") return;
    const poly = getVisibilityPolygon({ x: t.x, y: t.y });
    if (poly.length >= 3) polys.push(poly);
  });
  return polys;
}

// A visibility polygon as a Path2D in fog-buffer resolution (native px * fogBuf.resScale), matching
// roomPathFog so the LoS mask lines up with the fog layers it composites alongside.
function losPath(points) {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x * fogBuf.resScale, points[0].y * fogBuf.resScale);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i].x * fogBuf.resScale, points[i].y * fogBuf.resScale);
  path.closePath();
  return path;
}

// Native segments that block LIGHT (blocksLight; windows pass light), plus the map edges.
function lightSegments() {
  const segs = [];
  state.obstacles.forEach((ob) => {
    if (ob.blocksLight === false) return;
    if (ob.kind === "door" && ob.open) return; // open doors let light through
    const pts = (ob.points || []).map((p) => ({ x: p[0], y: p[1] }));
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1] });
  });
  const w = state.imageWidth || 0;
  const h = state.imageHeight || 0;
  segs.push({ a: { x: 0, y: 0 }, b: { x: w, y: 0 } });
  segs.push({ a: { x: w, y: 0 }, b: { x: w, y: h } });
  segs.push({ a: { x: w, y: h }, b: { x: 0, y: h } });
  segs.push({ a: { x: 0, y: h }, b: { x: 0, y: 0 } });
  return segs;
}

// Cached wall-occluded visibility polygon cast from a light; lights are static so this is reused
// until geometry or the light set changes (lightCache is cleared by invalidateCast).
// Every light source on the floor as { pos (native), radius (native px) }: placed lights
// (5d-1, native px) and token-carried torches (5d-2, at the token's position).
function lightSources() {
  const ppc = pxPerCellNative();
  const sources = [];
  state.lights.forEach((l) => sources.push({ pos: { x: l.x, y: l.y }, radius: l.radius || 0, color: l.color || LIGHT_DEFAULT_COLOR }));
  state.tokens.forEach((t) => {
    if ((t.light || 0) > 0) sources.push({ pos: { x: t.x, y: t.y }, radius: t.light * ppc, color: t.lightColor || LIGHT_DEFAULT_COLOR });
  });
  return sources;
}

// Cached wall-occluded visibility polygon cast from a native point. The cast doesn't depend on
// radius (radius only clips at composite), so the key is position + geometry version.
function getLightPolygon(pos) {
  const key = castVersion + "|" + Math.round(pos.x) + "|" + Math.round(pos.y);
  lightFrameKeys.add(key);
  let poly = lightCache.get(key);
  if (!poly) {
    poly = castVisibility(pos, lightSegments());
    lightCache.set(key, poly);
  }
  return poly;
}

// Union every light's coverage into lightCanvas (fog-buffer resolution): the wall-occluded polygon
// painted with a radial gradient — white (full reveal) out to the bright core, fading to transparent
// at the rim. The gradient bounds the reach (no separate circle clip needed) and the alpha falloff
// flows through compositeLoS's destination-out, giving a bright center and a soft dim halo (5d-3).
function buildLightCoverage() {
  lightCtx.setTransform(1, 0, 0, 1, 0, 0);
  lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
  lightSources().forEach(({ pos, radius }) => {
    const poly = getLightPolygon(pos);
    if (poly.length < 3 || radius <= 0) return;
    const cx = pos.x * fogBuf.resScale;
    const cy = pos.y * fogBuf.resScale;
    const rOuter = radius * fogBuf.resScale;
    const grad = lightCtx.createRadialGradient(cx, cy, rOuter * LIGHT_BRIGHT_FRACTION, cx, cy, rOuter);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    lightCtx.save();
    lightCtx.fillStyle = grad;
    lightCtx.fill(losPath(poly));
    lightCtx.restore();
  });
}

// 5e: paint every light's wall-occluded reach into tintCanvas in its own color, the alpha falling
// from LIGHT_TINT_CORE_ALPHA at the bright core to 0 at the rim — the colored counterpart to
// buildLightCoverage. tintCanvas is sized with the other fog buffers (resizeFogLayer), so it always
// matches lightCanvas. Takes the already-computed source list to avoid recomputing positions.
function buildLightTint(sources) {
  tintCtx.setTransform(1, 0, 0, 1, 0, 0);
  tintCtx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
  sources.forEach(({ pos, radius, color }) => {
    const poly = getLightPolygon(pos);
    if (poly.length < 3 || radius <= 0) return;
    const cx = pos.x * fogBuf.resScale;
    const cy = pos.y * fogBuf.resScale;
    const rOuter = radius * fogBuf.resScale;
    const grad = tintCtx.createRadialGradient(cx, cy, rOuter * LIGHT_BRIGHT_FRACTION, cx, cy, rOuter);
    grad.addColorStop(0, hexToRgba(color, LIGHT_TINT_CORE_ALPHA));
    grad.addColorStop(1, hexToRgba(color, 0));
    tintCtx.save();
    tintCtx.fillStyle = grad;
    tintCtx.fill(losPath(poly));
    tintCtx.restore();
  });
}

// 5e: composite the colored-light glow over the map additively (`lighter`), on BOTH the GM and the
// player view, drawn under the tokens so minis stay readable. Always-on: a brazier glows whether or
// not darkness is enabled. On the player view the later LoS/darkness overlay clips the glow to what
// the party can currently see, so unseen rooms don't light up. Native-space draw, mirroring
// compositeLoS's scale from fog-buffer resolution to the full image.
function compositeLightTint() {
  const sources = lightSources();
  if (!sources.length) return;
  buildLightTint(sources);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tintCanvas, 0, 0, tintCanvas.width, tintCanvas.height, 0, 0, state.imageWidth, state.imageHeight);
  ctx.restore();
}

function hitLight(native) {
  const ppc = pxPerCellNative();
  let best = null;
  let bestDist = Math.max(12, ppc / 2);
  state.lights.forEach((light) => {
    const p = { x: light.x, y: light.y };
    const d = Math.hypot(native.x - p.x, native.y - p.y);
    if (d < bestDist) { bestDist = d; best = light; }
  });
  return best;
}

// GM-only markers: a glow dot plus a dashed radius ring so the GM can see each light's reach.
function drawLights() {
  if (isPlayer || (!state.lights.length && !state.tokens.some((t) => (t.light || 0) > 0))) return;
  const ppc = pxPerCellNative();
  ctx.save();
  // Token-carried torches (5d-2): faint reach ring around the token, no center marker.
  state.tokens.forEach((t) => {
    if ((t.light || 0) <= 0) return;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.light * ppc, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(t.lightColor, 0.35);
    ctx.lineWidth = 1.5 / (cur.k * cur.ms);
    ctx.setLineDash([5 / (cur.k * cur.ms), 6 / (cur.k * cur.ms)]);
    ctx.stroke();
    ctx.setLineDash([]);
  });
  state.lights.forEach((light) => {
    const p = { x: light.x, y: light.y };
    const rNative = light.radius || 0;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rNative, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(light.color, 0.45);
    ctx.lineWidth = 1.5 / (cur.k * cur.ms);
    ctx.setLineDash([6 / (cur.k * cur.ms), 5 / (cur.k * cur.ms)]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 / (cur.k * cur.ms), 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(light.color, 0.95);
    ctx.fill();
    ctx.strokeStyle = "rgba(70,45,0,0.85)";
    ctx.lineWidth = 1 / (cur.k * cur.ms);
    ctx.stroke();
  });
  ctx.restore();
}

// The current floor's explored canvas, lazily created at the fog-buffer resolution. Runtime-only:
// it lives in memory keyed by floor and is gone on reload (persisting it to the save file is a
// later chunk). If the fog buffer resized, the old memory is rescaled into the new dimensions.
function getExploredCanvas() {
  const id = state.currentFloorId;
  let c = exploredMasks.get(id);
  if (!c || c.width !== losCanvas.width || c.height !== losCanvas.height) {
    const nc = document.createElement("canvas");
    nc.width = losCanvas.width;
    nc.height = losCanvas.height;
    if (c && c.width && c.height) nc.getContext("2d").drawImage(c, 0, 0, c.width, c.height, 0, 0, nc.width, nc.height);
    c = nc;
    exploredMasks.set(id, c);
  }
  return c;
}

// Player-view only: the three-state fog of war. Builds the current visibility mask, folds it into
// the floor's explored memory, then paints a darkness overlay — unexplored stays black, explored
// is dimmed to state.los.brightness, and currently-visible is fully clear. Fails open with no eyes.
// The hand-painted fog (compositeFog) still draws over this, so the GM can re-hide anything.
function compositeLoS() {
  const polys = playerVisionPolygons();
  if (!polys.length) return; // fail-open: no player tokens, show everything

  // Current visibility, opaque where seen.
  losCtx.setTransform(1, 0, 0, 1, 0, 0);
  losCtx.clearRect(0, 0, losCanvas.width, losCanvas.height);
  losCtx.fillStyle = "#ffffff";
  polys.forEach((poly) => losCtx.fill(losPath(poly)));

  // 5d: under darkness, you only see where line-of-sight AND light overlap.
  if (state.los.darkness) {
    buildLightCoverage();
    losCtx.save();
    losCtx.globalCompositeOperation = "destination-in";
    losCtx.drawImage(lightCanvas, 0, 0);
    losCtx.restore();
  }

  // Fold this frame's visibility into the floor's running memory.
  const explored = getExploredCanvas();
  const ectx = explored.getContext("2d");
  ectx.globalCompositeOperation = "source-over";
  ectx.drawImage(losCanvas, 0, 0);

  // Darkness overlay: black everywhere, lift explored to a dim level, lift visible fully clear.
  darkCtx.setTransform(1, 0, 0, 1, 0, 0);
  darkCtx.clearRect(0, 0, darkCanvas.width, darkCanvas.height);
  darkCtx.fillStyle = "#080909";
  darkCtx.fillRect(0, 0, darkCanvas.width, darkCanvas.height);
  darkCtx.save();
  darkCtx.globalCompositeOperation = "destination-out";
  darkCtx.globalAlpha = Math.max(0, Math.min(1, state.los.brightness ?? 0.5)); // explored -> dim
  darkCtx.drawImage(explored, 0, 0);
  darkCtx.globalAlpha = 1; // visible -> clear
  darkCtx.drawImage(losCanvas, 0, 0);
  darkCtx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(darkCanvas, 0, 0, darkCanvas.width, darkCanvas.height, 0, 0, state.imageWidth, state.imageHeight);
  ctx.restore();
}

export {
  invalidateCast, rayHit, castVisibility, getVisibilityPolygon, playerVisionPolygons, losPath, lightSegments, lightSources, compositeLightTint,
  getLightPolygon, buildLightCoverage, hitLight, drawLights, compositeLoS, getExploredCanvas, sightSegments, castVersion,
};
