// image-handles.js — on-canvas resize/rotate grips for a selected map image (GM, Move mode).
//
// Ported from Lodestar (MIT), themed to this app. When an image is selected, #imageHandles
// overlays the canvas in screen space with four corner resize grips and a rotation ball,
// tracking pan/zoom/rotation each frame. Resizing keeps the image's aspect ratio. These drive
// the same { w, h, rotation } fields the side-panel sliders already edit — this is just direct
// manipulation. Like the sliders, transforms aren't pushed to undo history (kept consistent).
//
// The grips carry their own pointer listeners, so dragging never touches the canvas pointer
// pipeline in main.js. The only per-frame hook is syncImageHandles(), called from render().

import { sel, state, controls, isPlayer, hooks } from "./state.js";
import { clientToCanvasPoint, screenToNative, nativeToScreen } from "./geometry.js";

const STYLE_ID = "image-handles-style";

const CSS = `
#imageHandles { inset: 0; pointer-events: none; position: absolute; z-index: 5; }
.img-handle {
  background: #fff;
  border: 2px solid var(--accent);
  border-radius: 2px;
  height: 12px;
  margin: -7px 0 0 -7px;
  pointer-events: auto;
  position: absolute;
  width: 12px;
}
.img-handle[data-corner="nw"], .img-handle[data-corner="se"] { cursor: nwse-resize; }
.img-handle[data-corner="ne"], .img-handle[data-corner="sw"] { cursor: nesw-resize; }
.img-rot-stem {
  background: var(--accent);
  height: 26px;
  margin-left: -1px;
  pointer-events: none;
  position: absolute;
  transform-origin: top center;
  width: 2px;
}
.img-rot-ball {
  background: var(--accent);
  border: 2px solid var(--bg);
  border-radius: 50%;
  cursor: grab;
  height: 16px;
  margin: -8px 0 0 -8px;
  pointer-events: auto;
  position: absolute;
  width: 16px;
}
`;

let box = null;
let imageEdit = null; // { mode:"resize"|"rotate", im, w0, h0, aspect }

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Native point in the pointer event, in world (native) coords.
function eventNative(e) {
  return screenToNative(clientToCanvasPoint(e));
}

// A native point expressed in an image's local (un-rotated) frame, relative to its center.
function imageLocalPoint(im, p) {
  const r = -((im.rotation || 0) * Math.PI) / 180;
  const dx = p.x - im.x;
  const dy = p.y - im.y;
  return { x: dx * Math.cos(r) - dy * Math.sin(r), y: dx * Math.sin(r) + dy * Math.cos(r) };
}

// Screen position of an image corner (sx,sy in {-1,1}), accounting for image + view rotation.
function imageCornerScreen(im, sx, sy) {
  const r = ((im.rotation || 0) * Math.PI) / 180;
  const lx = (sx * im.w) / 2;
  const ly = (sy * im.h) / 2;
  return nativeToScreen({ x: im.x + lx * Math.cos(r) - ly * Math.sin(r), y: im.y + lx * Math.sin(r) + ly * Math.cos(r) });
}

// Keep the side-panel sliders showing the live values as the image is dragged on canvas.
function syncPanelInputs(im) {
  if (controls.imageSize) controls.imageSize.value = Math.round(im.w);
  if (controls.imageRotation) controls.imageRotation.value = Math.round(im.rotation || 0);
}

// Reposition every grip in screen space. Called each frame from render(); hides itself whenever
// there's no eligible selected image (player view, nothing selected, or the image was deleted).
export function syncImageHandles() {
  if (!box) box = document.getElementById("imageHandles");
  if (!box) return;
  const im = sel.image;
  if (isPlayer || !im || !(state.images || []).includes(im)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const corners = {
    nw: imageCornerScreen(im, -1, -1),
    ne: imageCornerScreen(im, 1, -1),
    se: imageCornerScreen(im, 1, 1),
    sw: imageCornerScreen(im, -1, 1),
  };
  box.querySelectorAll(".img-handle").forEach((h) => {
    const c = corners[h.dataset.corner];
    h.style.left = `${c.x}px`;
    h.style.top = `${c.y}px`;
  });

  const center = nativeToScreen({ x: im.x, y: im.y });
  const topMid = { x: (corners.nw.x + corners.ne.x) / 2, y: (corners.nw.y + corners.ne.y) / 2 };
  let ux = topMid.x - center.x;
  let uy = topMid.y - center.y;
  const ulen = Math.hypot(ux, uy) || 1;
  ux /= ulen;
  uy /= ulen;

  const ball = box.querySelector(".img-rot-ball");
  ball.style.left = `${topMid.x + ux * 26}px`;
  ball.style.top = `${topMid.y + uy * 26}px`;

  const stem = box.querySelector(".img-rot-stem");
  stem.style.left = `${topMid.x}px`;
  stem.style.top = `${topMid.y}px`;
  stem.style.transform = `rotate(${(Math.atan2(uy, ux) * 180) / Math.PI - 90}deg)`;
}

function startImageResize(e) {
  if (!sel.image) return;
  e.preventDefault();
  e.stopPropagation();
  const im = sel.image;
  imageEdit = { mode: "resize", im, w0: im.w, h0: im.h, aspect: im.w / im.h || 1 };
  window.addEventListener("pointermove", onImageEditMove);
  window.addEventListener("pointerup", endImageEdit, { once: true });
}

function startImageRotate(e) {
  if (!sel.image) return;
  e.preventDefault();
  e.stopPropagation();
  imageEdit = { mode: "rotate", im: sel.image };
  window.addEventListener("pointermove", onImageEditMove);
  window.addEventListener("pointerup", endImageEdit, { once: true });
}

function onImageEditMove(e) {
  if (!imageEdit) return;
  const im = imageEdit.im;
  const p = eventNative(e);
  if (imageEdit.mode === "resize") {
    // Scale from how far the cursor sits out along the image's own axes, aspect maintained.
    const l = imageLocalPoint(im, p);
    const factor = Math.max(Math.abs(l.x) / (imageEdit.w0 / 2), Math.abs(l.y) / (imageEdit.h0 / 2)) || 1;
    im.w = Math.max(20, imageEdit.w0 * factor);
    im.h = im.w / imageEdit.aspect;
  } else {
    // Local "up" points at the cursor.
    const ang = (Math.atan2(p.y - im.y, p.x - im.x) * 180) / Math.PI;
    im.rotation = (((ang + 90) % 360) + 360) % 360;
  }
  syncPanelInputs(im);
  hooks.render();
}

function endImageEdit() {
  imageEdit = null;
  window.removeEventListener("pointermove", onImageEditMove);
  hooks.renderAndSync(); // commit the resized/rotated image to players
}

function setupImageHandles() {
  if (!box) box = document.getElementById("imageHandles");
  if (!box) return;
  box.querySelectorAll(".img-handle").forEach((h) => h.addEventListener("pointerdown", startImageResize));
  box.querySelector(".img-rot-ball")?.addEventListener("pointerdown", startImageRotate);
}

function init() {
  injectStyles();
  setupImageHandles(); // grips wire even in player view but stay hidden; harmless
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
