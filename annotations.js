/* annotations.js — floating notes, dropped map images, and ping ripples.
 * The draw + compute + hit-test core for the three annotation layers, plus the shared image cache
 * (getTokenImage, reused by token art at step 10) and the self-contained ping animation loop.
 * Render-triggering goes through hooks.render so this leaf never imports the render layer. The
 * add/edit/relay shells (addNote, addImageFromDataURL, triggerPing) stay in app.js until step 14.
 */

import {
  ctx, PING_DURATION, isPlayer, state, cur, hooks, sel,
} from "./state.js";
import {
  snapToGrid, nativeToScreen,
} from "./geometry.js";

const tokenImageCache = new Map(); // data URL -> HTMLImageElement, so token art draws each frame
let pings = [];
let pingRaf = 0;

// Snap an image's center when the image snap toggle is on.
function snapImage(native) {
  return state.grid.snapImages ? snapToGrid(native) : native;
}

// Token art is loaded once per data URL and cached; the image draws on every frame.
function getTokenImage(src) {
  if (!src) return null;
  let img = tokenImageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = hooks.render; // redraw once the art is decoded
    img.src = src;
    tokenImageCache.set(src, img);
  }
  return img;
}

// Droppable images live in native coords (x,y = center; w,h = size) and rotate with the map.
// On the player display only images flagged showPlayers are drawn.
function drawImages() {
  const list = state.images || [];
  if (!list.length) return;
  list.forEach((im) => {
    if (isPlayer && !im.showPlayers) return;
    const img = getTokenImage(im.src);
    if (!img || !img.complete || !img.naturalWidth) return;
    ctx.save();
    const irot = (im.rotation || 0) * Math.PI / 180;
    if (irot) {
      ctx.translate(im.x, im.y);
      ctx.rotate(irot);
      ctx.translate(-im.x, -im.y);
    }
    ctx.drawImage(img, im.x - im.w / 2, im.y - im.h / 2, im.w, im.h);
    if (!isPlayer && im === sel.image) {
      ctx.lineWidth = 2 / (cur.k * cur.ms);
      ctx.strokeStyle = "#b1c301";
      ctx.setLineDash([8 / (cur.k * cur.ms), 5 / (cur.k * cur.ms)]);
      ctx.strokeRect(im.x - im.w / 2, im.y - im.h / 2, im.w, im.h);
    }
    ctx.restore();
  });
}

function hitImage(native) {
  for (let i = state.images.length - 1; i >= 0; i--) {
    const im = state.images[i];
    let dx = native.x - im.x;
    let dy = native.y - im.y;
    const irot = (im.rotation || 0) * Math.PI / 180;
    if (irot) {
      const c = Math.cos(-irot);
      const s = Math.sin(-irot);
      [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
    }
    if (Math.abs(dx) <= im.w / 2 && Math.abs(dy) <= im.h / 2) return im;
  }
  return null;
}

// Notes are GM-only sticky labels anchored to a native point but drawn in screen space so the
// text stays a constant, readable size and orientation at any zoom or rotation.
function wrapNoteText(text, maxW) {
  const out = [];
  String(text || "").split("\n").forEach((para) => {
    const words = para.split(/\s+/);
    let line = "";
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (line && ctx.measureText(test).width > maxW) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    });
    out.push(line);
  });
  return out.length ? out : [""];
}

function noteFont(note) {
  return `600 ${Math.round(13 * (note.scale || 1))}px Inter, ui-sans-serif, sans-serif`;
}

function noteLayout(note) {
  const sc = note.scale || 1;
  ctx.save();
  ctx.font = noteFont(note);
  const padX = 9 * sc;
  const padY = 7 * sc;
  const lh = 17 * sc;
  const boxW = 176 * sc;
  const lines = wrapNoteText(note.text, boxW - padX * 2);
  ctx.restore();
  return { lines, padX, padY, lh, boxW, boxH: padY * 2 + lines.length * lh };
}

function noteScreenRect(note) {
  const s = nativeToScreen({ x: note.x, y: note.y });
  const { boxW, boxH } = noteLayout(note);
  return { x: s.x, y: s.y, w: boxW, h: boxH };
}

function drawNotes() {
  const list = state.notes || [];
  if (!list.length) return;
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  list.forEach((note) => {
    const s = nativeToScreen({ x: note.x, y: note.y });
    const { lines, padX, padY, lh, boxW, boxH } = noteLayout(note);
    ctx.font = noteFont(note);
    const noteSelected = note === sel.note;
    ctx.fillStyle = "rgba(244, 226, 140, 0.95)";
    ctx.strokeStyle = noteSelected ? "#b1c301" : "rgba(0,0,0,0.45)";
    ctx.lineWidth = noteSelected ? 2 : 1;
    ctx.beginPath();
    ctx.rect(s.x, s.y, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1a1400";
    lines.forEach((ln, i) => ctx.fillText(ln, s.x + padX, s.y + padY + i * lh));
  });
  ctx.restore();
}

function hitNote(screenPt) {
  for (let i = state.notes.length - 1; i >= 0; i--) {
    const r = noteScreenRect(state.notes[i]);
    if (screenPt.x >= r.x && screenPt.x <= r.x + r.w && screenPt.y >= r.y && screenPt.y <= r.y + r.h) {
      return state.notes[i];
    }
  }
  return null;
}

function addPing(x, y, color) {
  pings.push({ x, y, color: color || "#d6a94d", start: performance.now() });
  ensurePingLoop();
}

function ensurePingLoop() {
  if (pingRaf) return;
  const tick = () => {
    pings = pings.filter((p) => performance.now() - p.start < PING_DURATION);
    hooks.render();
    if (pings.length) {
      pingRaf = requestAnimationFrame(tick);
    } else {
      pingRaf = 0;
    }
  };
  pingRaf = requestAnimationFrame(tick);
}

function drawPings() {
  if (!pings.length) return;
  const now = performance.now();
  ctx.save();
  pings.forEach((ping) => {
    const t = (now - ping.start) / PING_DURATION;
    const screen = nativeToScreen(ping);
    const radius = 8 + t * 46;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.strokeStyle = ping.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

export {
  wrapNoteText, noteFont, noteLayout, noteScreenRect, drawNotes, hitNote, drawImages, hitImage,
  snapImage, getTokenImage, addPing, ensurePingLoop, drawPings,
};
