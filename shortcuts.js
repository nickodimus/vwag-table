// shortcuts.js — keyboard & mouse cheatsheet overlay.
//
// A self-contained leaf module. It reads no game state and writes nothing: it injects
// its own <dialog>, its own scoped <style>, and its own "?" key listener, then gets out
// of the way. Loaded as a standalone <script type="module"> from index.html, so nothing
// in main.js has to know it exists.
//
// The panel is context-aware: the GM view (/) shows the full tool/fog/editing keymap;
// the player view (?view=player) shows just the walk/stairs/camera keys players actually have.
// Both keymaps are authored from the real onKeyDown in main.js, not copied from upstream.

const isPlayer = new URLSearchParams(location.search).get("view") === "player";

// Row shapes:
//   { keys: ["V"], label }            -> one or more <kbd> chips (space-separated)
//   { keys: ["Ctrl", "Z"], join: "+" } -> <kbd> chips joined by a literal "+"
//   { mouse: "Alt+click", label }     -> a mouse-gesture pill instead of key chips
const GM_GROUPS = [
  {
    title: "Tools",
    rows: [
      { keys: ["V"], label: "Move / select" },
      { keys: ["T"], label: "Token" },
      { keys: ["A"], label: "Area of effect" },
      { keys: ["M"], label: "Measure" },
      { keys: ["S"], label: "Stairs" },
      { keys: ["G"], label: "Map link" },
      { keys: ["D"], label: "Draw wall / obstacle" },
      { keys: ["L"], label: "Light" },
    ],
  },
  {
    title: "Fog",
    rows: [
      { keys: ["P"], label: "Fog area" },
      { keys: ["N"], label: "Named fog area" },
      { keys: ["B"], label: "Paint fog" },
      { keys: ["E"], label: "Erase fog" },
      { keys: ["[", "]"], label: "Brush size" },
    ],
  },
  {
    title: "View",
    rows: [
      { keys: ["F"], label: "Fit to screen" },
      { mouse: "Wheel", label: "Zoom" },
      { mouse: "Middle-drag", label: "Pan (any tool)" },
    ],
  },
  {
    title: "Editing",
    rows: [
      { keys: ["Ctrl", "Z"], join: "+", label: "Undo" },
      { keys: ["Ctrl", "Shift", "Z"], join: "+", label: "Redo" },
      { keys: ["Del"], label: "Delete selected" },
      { keys: ["↑", "↓", "←", "→"], label: "Nudge selected token" },
      { keys: ["Enter"], label: "Finish shape" },
      { keys: ["Esc"], label: "Cancel shape" },
    ],
  },
  {
    title: "Mouse",
    rows: [
      { mouse: "Drag", label: "Move token / pan map" },
      { mouse: "Alt+click", label: "Ping a spot" },
      { mouse: "Right-click", label: "Delete obstacle" },
      { mouse: "Double-click", label: "Place point / load map" },
    ],
  },
];

const PLAYER_GROUPS = [
  {
    title: "Move",
    rows: [
      { keys: ["↑", "↓", "←", "→"], label: "Walk selected token" },
      { keys: ["S"], label: "Take the stairs" },
      { keys: ["D"], label: "Descend a map link" },
    ],
  },
  {
    title: "Camera",
    rows: [
      { keys: ["C"], label: "Follow the party" },
      { keys: ["Z"], label: "Fit-to-party zoom" },
      { keys: ["F"], label: "Fullscreen" },
    ],
  },
  {
    title: "Touch",
    rows: [{ mouse: "Double-tap token", label: "Traverse stairs / link" }],
  },
];

const STYLE_ID = "shortcuts-style";
const DIALOG_ID = "shortcutsDialog";

// Scoped CSS, themed off the app's existing design tokens (--panel, --line, --accent, ...).
// Every selector is namespaced under .shortcuts-dialog so we never restyle <kbd> elsewhere.
const CSS = `
.shortcuts-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text);
  padding: 0;
  width: min(94vw, 680px);
}
.shortcuts-dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
.shortcuts-dialog form { display: grid; gap: 16px; margin: 0; padding: 18px; }
.shortcuts-head {
  align-items: center;
  display: flex;
  gap: 12px;
  justify-content: space-between;
}
.shortcuts-head h2 { font-size: 1rem; margin: 0; }
.shortcuts-head .close-btn {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  min-height: 34px;
  padding: 0 14px;
}
.shortcuts-hint { color: var(--muted); font-size: 0.78rem; margin: -6px 0 0; }
.shortcuts-grid {
  display: grid;
  gap: 18px 24px;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.sc-group h3 {
  color: var(--accent);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  margin: 0 0 8px;
  text-transform: uppercase;
}
.sc-row {
  align-items: center;
  color: var(--muted);
  display: flex;
  font-size: 0.84rem;
  gap: 6px;
  min-height: 26px;
}
.sc-row .sc-label { margin-left: auto; text-align: right; }
.shortcuts-dialog kbd {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 5px;
  color: var(--text);
  font-family: inherit;
  font-size: 0.72rem;
  line-height: 1;
  min-width: 18px;
  padding: 4px 6px;
  text-align: center;
}
.sc-mouse {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  font-size: 0.72rem;
  padding: 3px 7px;
  white-space: nowrap;
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Build one cheatsheet row: the key chips (or a mouse pill) on the left, the label right-aligned.
function buildRow(row) {
  const el = document.createElement("div");
  el.className = "sc-row";

  if (row.mouse) {
    const pill = document.createElement("span");
    pill.className = "sc-mouse";
    pill.textContent = row.mouse;
    el.appendChild(pill);
  } else {
    row.keys.forEach((key, i) => {
      if (i > 0 && row.join === "+") el.appendChild(document.createTextNode("+"));
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      el.appendChild(kbd);
    });
  }

  const label = document.createElement("span");
  label.className = "sc-label";
  label.textContent = row.label;
  el.appendChild(label);
  return el;
}

function buildDialog() {
  const groups = isPlayer ? PLAYER_GROUPS : GM_GROUPS;

  const dialog = document.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.className = "shortcuts-dialog";

  const form = document.createElement("form");
  form.method = "dialog"; // a submit (the Close button or Esc) closes the dialog for free

  const head = document.createElement("div");
  head.className = "shortcuts-head";
  const h2 = document.createElement("h2");
  h2.textContent = isPlayer ? "Player controls" : "Keyboard & mouse";
  const close = document.createElement("button");
  close.type = "submit";
  close.value = "cancel";
  close.className = "close-btn";
  close.textContent = "Close";
  head.append(h2, close);

  const hint = document.createElement("p");
  hint.className = "shortcuts-hint";
  hint.textContent = "Press ? anytime to toggle this.";

  const grid = document.createElement("div");
  grid.className = "shortcuts-grid";
  groups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "sc-group";
    const title = document.createElement("h3");
    title.textContent = group.title;
    section.appendChild(title);
    group.rows.forEach((row) => section.appendChild(buildRow(row)));
    grid.appendChild(section);
  });

  form.append(head, hint, grid);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  return dialog;
}

// Don't fire while the user is typing (note bodies are contenteditable; name fields are inputs).
function shouldIgnore(event) {
  const t = event.target;
  return !!(t?.matches?.("input, textarea, select") || t?.isContentEditable);
}

function init() {
  if (document.getElementById(DIALOG_ID)) return; // idempotent if loaded twice
  injectStyles();
  const dialog = buildDialog();

  window.addEventListener("keydown", (event) => {
    if (event.key !== "?") return;
    if (shouldIgnore(event)) return;
    event.preventDefault();
    if (dialog.open) dialog.close();
    else dialog.showModal();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
