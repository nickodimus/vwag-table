// pdf-windows.js — GM-only floating PDF reference windows.
//
// A self-contained leaf module, ported from Lodestar (MIT) and themed to this app's tokens.
// Draggable / resizable viewers for rulebooks, stat blocks, and handouts. Session-only: each
// PDF is shown through the browser's native viewer via an <iframe> pointed at an object URL —
// no PDF.js, no external library, lean and fast. Nothing here touches game state, so PDFs are
// never synced to players and never saved into a map.
//
// Wiring from index.html (markup lives there, behavior lives here):
//   #pdfBtn        — the toolbar trigger (under the Player display button)
//   #pdfFileInput  — a hidden <input type=file accept=application/pdf multiple>
//   #pdfLayer      — an empty absolutely-positioned div inside .stage-wrap

const isPlayer = new URLSearchParams(location.search).get("view") === "player";

const STYLE_ID = "pdf-windows-style";

const CSS = `
#pdfLayer {
  inset: 0;
  pointer-events: none;
  position: absolute;
  z-index: 30;
}
.app-shell[data-role="player"] #pdfLayer,
.app-shell[data-role="player"] #pdfBtn { display: none; }
.pdf-window {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  height: 540px;
  overflow: hidden;
  pointer-events: auto;
  position: absolute;
  width: 420px;
}
.pdf-head {
  align-items: center;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  cursor: move;
  display: flex;
  gap: 8px;
  padding: 6px 8px;
}
.pdf-title {
  color: var(--text);
  flex: 1;
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-head button {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  cursor: pointer;
  font-size: 0.76rem;
  min-height: 26px;
  padding: 0 8px;
}
.pdf-head .pdf-close { font-size: 1rem; min-width: 28px; padding: 0; }
.pdf-head button:hover { border-color: var(--accent); }
.pdf-frame { background: #fff; border: 0; flex: 1; width: 100%; }
.pdf-resize {
  bottom: 0;
  cursor: nwse-resize;
  height: 16px;
  position: absolute;
  right: 0;
  width: 16px;
}
.pdf-resize::after {
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  bottom: 4px;
  content: "";
  height: 7px;
  position: absolute;
  right: 4px;
  width: 7px;
}
`;

const pdfWindows = []; // { el, url }
let pdfZ = 40;
let pdfLayer = null;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// During a drag/resize the iframe must not swallow pointer moves, or the gesture dies the
// moment the cursor crosses the PDF. Toggle the frame's pointer-events off for the duration.
function pdfFramePointer(el, on) {
  const f = el.querySelector(".pdf-frame");
  if (f) f.style.pointerEvents = on ? "" : "none";
}

function startPdfDrag(e, el) {
  if (e.target.closest("button")) return; // header buttons (Swap/Close) aren't drag handles
  e.preventDefault();
  pdfFramePointer(el, false);
  const ox = el.offsetLeft - e.clientX;
  const oy = el.offsetTop - e.clientY;
  const move = (ev) => {
    el.style.left = `${ev.clientX + ox}px`;
    el.style.top = `${ev.clientY + oy}px`;
  };
  const up = () => {
    pdfFramePointer(el, true);
    window.removeEventListener("pointermove", move);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function startPdfResize(e, el) {
  e.preventDefault();
  e.stopPropagation();
  pdfFramePointer(el, false);
  const sx = e.clientX;
  const sy = e.clientY;
  const w0 = el.offsetWidth;
  const h0 = el.offsetHeight;
  const move = (ev) => {
    el.style.width = `${Math.max(220, w0 + ev.clientX - sx)}px`;
    el.style.height = `${Math.max(160, h0 + ev.clientY - sy)}px`;
  };
  const up = () => {
    pdfFramePointer(el, true);
    window.removeEventListener("pointermove", move);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
}

function closePdfWindow(rec) {
  URL.revokeObjectURL(rec.url); // free the object URL so we don't leak the file in memory
  rec.el.remove();
  const i = pdfWindows.indexOf(rec);
  if (i >= 0) pdfWindows.splice(i, 1);
}

function swapPdf(rec) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "application/pdf";
  inp.addEventListener("change", () => {
    const f = inp.files?.[0];
    if (!f) return;
    URL.revokeObjectURL(rec.url);
    rec.url = URL.createObjectURL(f);
    rec.el.querySelector(".pdf-frame").src = rec.url;
    rec.el.querySelector(".pdf-title").textContent = f.name;
  });
  inp.click();
}

function createPdfWindow(file) {
  if (!file || file.type !== "application/pdf" || !pdfLayer) return;
  const url = URL.createObjectURL(file);

  const el = document.createElement("div");
  el.className = "pdf-window";
  // Cascade each new window so a stack of opened PDFs doesn't land exactly on top of itself.
  el.style.left = `${40 + (pdfWindows.length % 6) * 26}px`;
  el.style.top = `${40 + (pdfWindows.length % 6) * 26}px`;
  el.style.zIndex = ++pdfZ;

  const head = document.createElement("div");
  head.className = "pdf-head";
  const title = document.createElement("span");
  title.className = "pdf-title";
  title.textContent = file.name; // textContent, never innerHTML — filenames are untrusted
  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "pdf-swap";
  swap.title = "Open a different PDF here";
  swap.textContent = "Swap";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pdf-close";
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = "&times;";
  head.append(title, swap, close);

  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.title = "PDF document";
  frame.src = url; // native browser PDF viewer

  const grip = document.createElement("div");
  grip.className = "pdf-resize";
  grip.title = "Drag to resize";

  el.append(head, frame, grip);

  const rec = { el, url };
  el.addEventListener("pointerdown", () => (el.style.zIndex = ++pdfZ)); // click bumps to top
  head.addEventListener("pointerdown", (e) => startPdfDrag(e, el));
  close.addEventListener("click", () => closePdfWindow(rec));
  swap.addEventListener("click", () => swapPdf(rec));
  grip.addEventListener("pointerdown", (e) => startPdfResize(e, el));

  pdfLayer.appendChild(el);
  pdfWindows.push(rec);
}

function init() {
  if (isPlayer) return; // GM-only; players never see PDF windows
  injectStyles();
  pdfLayer = document.getElementById("pdfLayer");
  const btn = document.getElementById("pdfBtn");
  const input = document.getElementById("pdfFileInput");
  if (!pdfLayer || !btn || !input) return; // markup not present; bail quietly

  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", (event) => {
    [...(event.target.files || [])].forEach(createPdfWindow);
    input.value = ""; // reset so re-opening the same file fires change again
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
