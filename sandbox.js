// sandbox.js — public sandbox mode for the vtt.worhl.net demo host.
//
// A self-contained leaf module (same pattern as shortcuts/pdf/image-handles). When the
// client is served from vtt.worhl.net — the public "try it now" front door, which has NO
// backend proxy — this hides the one control that points at a backend that isn't there
// (the injected login button) and drops a small corner badge explaining the sandbox.
//
// Everything else backend-related is already dormant on vtt by the existing architecture:
//   - the relay holds off until there's a login token (sync.js _openSocket), and you can't
//     log in here, so it never opens a doomed socket;
//   - the Fallon buttons (#onlineSection) only un-hide when logged in, and localStorage is
//     per-origin so a game.worhl.net login can't carry over — they stay hidden on their own.
// So this module only has to hide the login affordance and label the sandbox.
//
// A ?sandbox query param forces sandbox mode anywhere, so it can be previewed locally
// without deploying to vtt.

import { isSandbox } from "./state.js";

const STYLE_ID = "sandbox-style";

const CSS = `
#vwagLoginBtn, #onlineSection { display: none !important; }
.vtt-sandbox-badge {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  bottom: 10px;
  color: var(--muted);
  font-size: 0.72rem;
  left: 10px;
  line-height: 1.35;
  max-width: 250px;
  padding: 6px 10px;
  pointer-events: none;
  position: fixed;
  z-index: 40;
}
.vtt-sandbox-badge strong { color: var(--text); display: block; font-size: 0.78rem; }
.vtt-sandbox-badge a { color: #b1c301; display: inline-block; margin-top: 4px; pointer-events: auto; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function injectBadge() {
  if (document.querySelector(".vtt-sandbox-badge")) return;
  const badge = document.createElement("div");
  badge.className = "vtt-sandbox-badge";
  const title = document.createElement("strong");
  title.textContent = "Sandbox";
  badge.appendChild(title);
  // Accurate split: maps persist/export locally; live session state has no server save here.
  badge.appendChild(document.createTextNode("export to keep a map · game state isn't saved"));
  badge.appendChild(document.createElement("br"));
  const guide = document.createElement("a");
  guide.href = "manual.html";
  guide.target = "_blank";
  guide.rel = "noopener";
  guide.textContent = "New here? Read the guide →";
  badge.appendChild(guide);
  document.body.appendChild(badge);
}

function init() {
  if (!isSandbox) return;
  injectStyles(); // CSS hides #vwagLoginBtn even though api.js injects it after this runs
  injectBadge();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
