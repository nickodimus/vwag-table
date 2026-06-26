// api.js — the "Willow" bridge between vwag-table and the VWAG FastAPI on fallon.
//
// Self-contained module (Path A): it owns the whole login/register feature —
// transport, the toolbar button, the modal, its styles, and all wiring. To
// remove the feature, delete this file and its <script> tag in index.html.
// Nothing in state.js / main.js / styles.css depends on it.
//
// Transport surface (consumed here today, and by the NEXT Willow chunk that
// fetches settlement NPCs):
//   login(username, password)        -> { ok, username?, error? }
//   register(username, email, pass)  -> { ok, username?, error? }
//   logout()                          -> clears the stored token
//   isLoggedIn()  getUsername()  getToken()  authHeader()
//   apiFetch(path, opts)              -> fetch wrapper: base URL + Bearer + JSON
//
// Auth model (server side, shipped): the token IS the player's unique_key, a
// plaintext UUID. POST /api/auth/login returns it; we store it and send it as
// `Authorization: Bearer <unique_key>` on every guarded call. See VWAG's
// docs/source/security.md.
//
// Base URL is a single constant. Today it points at the LAN (plain HTTP, fine
// on the off-grid wire). When the vwag.worhl.net TLS vhost lands, this one line
// changes to https://vwag.worhl.net — no other edit.
//
// Chunk 4 (online tier): this module also registers a remote content source into
// content.js's resolver (fetchModule / fetchImage). Any map or image not found
// locally is then pulled from fallon and cached down into IndexedDB — fallon is
// the source of truth, but once a map has been opened it plays fully off-grid.

import { registerRemoteSource } from "./content.js";

const FALLON_BASE = "http://10.10.0.10:8002";

const STORE_KEY  = "vwag.unique_key";
const STORE_USER = "vwag.username";

// GM view only — the player display (?view=player) never shows login.
const IS_PLAYER =
  new URLSearchParams(window.location.search).get("view") === "player";


// ── token state ──────────────────────────────────────────────────────────────

let _token    = null;
let _username = null;

function _loadStored() {
  try {
    _token    = localStorage.getItem(STORE_KEY)  || null;
    _username = localStorage.getItem(STORE_USER) || null;
  } catch {
    _token = _username = null;   // private mode / storage disabled
  }
}

function _store(token, username) {
  _token = token;
  _username = username;
  try {
    if (token) {
      localStorage.setItem(STORE_KEY, token);
      localStorage.setItem(STORE_USER, username || "");
    } else {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(STORE_USER);
    }
  } catch {
    /* non-persistent session is acceptable; in-memory token still works */
  }
}

export function getToken()    { return _token; }
export function getUsername() { return _username; }
export function isLoggedIn()  { return !!_token; }

export function logout() {
  _store(null, null);
  _refreshButton();
}

export function authHeader() {
  return _token ? { Authorization: `Bearer ${_token}` } : {};
}


// ── transport ────────────────────────────────────────────────────────────────

// Pull a human-readable message out of a FastAPI error body. `detail` is a
// string for our HTTPExceptions (401/409/400) and a list for 422 validation.
function _errorMessage(body, status) {
  const d = body && body.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) {
    const first = d[0];
    if (first && typeof first.msg === "string") {
      // e.g. "String should have at least 6 characters" on the password field.
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
      return field ? `${field}: ${first.msg}` : first.msg;
    }
  }
  return `Request failed (${status}).`;
}

async function _postJson(path, payload) {
  let resp;
  try {
    resp = await fetch(`${FALLON_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Network error — fallon down / off-grid / wrong host. Distinct from auth.
    return { ok: false, error: "Can't reach Victen Worhl. Is fallon online?" };
  }

  let body = null;
  try { body = await resp.json(); } catch { /* empty or non-JSON body */ }

  if (!resp.ok) return { ok: false, error: _errorMessage(body, resp.status) };
  return { ok: true, body };
}

export async function login(username, password) {
  const r = await _postJson("/api/auth/login", { username, password });
  if (!r.ok) return r;
  _store(r.body.unique_key, r.body.username);
  return { ok: true, username: r.body.username };
}

export async function register(username, email, password) {
  const r = await _postJson("/api/auth/register", { username, email, password });
  if (!r.ok) return r;
  _store(r.body.unique_key, r.body.username);
  return { ok: true, username: r.body.username };
}

// General authed fetch for the NEXT chunk (settlement NPC pulls). Returns
// parsed JSON, or throws an Error tagged with .status on a non-2xx so callers
// can branch on 401 (token went stale) vs other failures.
export async function apiFetch(path, opts = {}) {
  const resp = await fetch(`${FALLON_BASE}${path}`, {
    ...opts,
    headers: { ...authHeader(), ...(opts.headers || {}) },
  });
  if (!resp.ok) {
    const err = new Error(`apiFetch ${path} -> ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.status === 204 ? null : resp.json();
}


// ── remote content source (the resolver's fallon tier) ───────────────────────
// content.js's resolver calls these when a module/image isn't found locally and
// caches any hit down into IndexedDB, so the next resolve — and all off-grid
// play — is local. A thrown error (404 / network) is the resolver's signal to
// fall through to local-only, so these don't swallow failures themselves.

function _blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const remoteSource = {
  // GET /api/vtt/modules/{id} -> { ..., data: <browser module record> }. The
  // resolver wants the record itself, which fallon stores in the `data` column.
  async fetchModule(id) {
    const row = await apiFetch(`/api/vtt/modules/${encodeURIComponent(id)}`);
    return row && row.data ? row.data : null;
  },
  // GET /api/vtt/images/{id} -> { ..., url }. Bytes live at FALLON_BASE+url
  // (/static/vtt/...). Pull them and hand back a dataURL — the form the image
  // store and renderer use.
  async fetchImage(imageId) {
    const meta = await apiFetch(`/api/vtt/images/${encodeURIComponent(imageId)}`);
    if (!meta || !meta.url) return "";
    const resp = await fetch(`${FALLON_BASE}${meta.url}`);
    if (!resp.ok) return "";
    return _blobToDataURL(await resp.blob());
  },
};

// The map catalog for the "From fallon" picker — lightweight rows (no data blob):
//   [{ id, name, map_kind, parent_id, updated_at }]. Returns [] on any failure
// (off-grid / fallon down) so the picker shows empty instead of throwing.
export async function listRemoteModules() {
  try {
    const rows = await apiFetch("/api/vtt/modules");
    if (!Array.isArray(rows)) return [];
    // Absolutize the cover thumb URL so the picker can use it directly as an <img>
    // src (keeps FALLON_BASE here, where the host concern already lives).
    return rows.map((r) => ({
      ...r,
      thumbnail_url: r.thumbnail_url ? `${FALLON_BASE}${r.thumbnail_url}` : null,
    }));
  } catch {
    return [];
  }
}


// ── publish (write path: browser → fallon) ───────────────────────────────────
// The mirror of the remote source above: these push a locally authored map UP to
// fallon. Guarded server-side (require_player), so apiFetch must carry a Bearer —
// callers gate on isLoggedIn() first. apiFetch throws on non-2xx with .status set,
// so a 401 (token went stale) is distinguishable from fallon being unreachable.

// PUT /api/vtt/modules/{id}. Body mirrors the columns fallon extracts; `data` is
// the whole browser module record, stored verbatim so a later pull round-trips.
// `thumbnail` is the served path of the cover thumb (already pushed via
// putRemoteImage), so the From-fallon picker can show it without pulling the map.
export async function publishModule(record, thumbnail = null) {
  return apiFetch(`/api/vtt/modules/${encodeURIComponent(record.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: record.name ?? null,
      map_kind: record.mapKind || "battle",
      parent_id: record.parentId ?? null,
      data: record,
      thumbnail: thumbnail ?? null,
    }),
  });
}

// PUT /api/vtt/images/{id}. The browser holds image bytes as dataURLs already, so
// we ship the dataURL as-is; fallon decodes it to disk. Named putRemoteImage to
// avoid colliding with db.js's local putImage (both are imported into main.js).
export async function putRemoteImage(imageId, dataURL, width, height) {
  return apiFetch(`/api/vtt/images/${encodeURIComponent(imageId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data_url: dataURL,
      width: width ?? null,
      height: height ?? null,
    }),
  });
}

// PUT /api/vtt/sessions/{id}. The play-state checkpoint — the session record's
// full JSON in `data`, with module_id (the FK) + name as columns. fallon 400s if
// the module isn't published yet; the checkpoint flow publishes it first.
export async function publishSession(record) {
  return apiFetch(`/api/vtt/sessions/${encodeURIComponent(record.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      module_id: record.moduleId || record.id,
      name: record.name ?? null,
      data: record,
    }),
  });
}

// True if a module already lives on fallon — drives the overwrite confirm. A 404
// means "new, no confirm needed"; any other error propagates so the caller can
// treat it as fallon-unreachable.
export async function remoteModuleExists(id) {
  try {
    await apiFetch(`/api/vtt/modules/${encodeURIComponent(id)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// GET /api/vtt/sessions/{id} → the checkpointed session record (the browser's
// session JSON in `data`), or throws .status 404 if fallon has no saved session
// for this map. Open endpoint (read), so it works without a Bearer.
export async function fetchRemoteSession(id) {
  const meta = await apiFetch(`/api/vtt/sessions/${encodeURIComponent(id)}`);
  return meta ? meta.data : null;
}

// Light up the resolver's fallon tier. The player view (?view=player) receives
// its state over BroadcastChannel and never resolves content itself, so it stays
// network-silent — only the GM side registers.
if (!IS_PLAYER) registerRemoteSource(remoteSource);


// ── injected styles ──────────────────────────────────────────────────────────

const STYLES = `
.vwag-login-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--text);
  padding: 0;
  width: min(92vw, 360px);
}
.vwag-login-dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
.vwag-login-dialog form { display: grid; gap: 14px; margin: 0; padding: 22px; }

.vwag-login-brand { text-align: center; display: grid; gap: 2px; margin-bottom: 4px; }
.vwag-login-brand .wordmark {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.6rem; font-weight: 600; letter-spacing: 1px;
  color: var(--brand-bright); margin: 0;
}
.vwag-login-brand .subtitle {
  font-style: italic; font-size: 0.85rem; color: var(--muted); margin: 0;
}

.vwag-login-field { display: grid; gap: 5px; }
.vwag-login-field label { font-size: 0.8rem; color: var(--muted); }
.vwag-login-dialog input {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px; color: var(--text);
  min-height: 40px; padding: 0 12px; width: 100%;
  font-size: 0.95rem;
}
.vwag-login-dialog input:focus { outline: none; border-color: var(--brand-bright); }
.vwag-login-field.hidden { display: none; }

.vwag-login-pw { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.vwag-login-eye {
  background: var(--brand); border: none; border-radius: 6px;
  color: var(--on-brand); cursor: pointer; width: 44px;
  display: grid; place-items: center;
}
.vwag-login-eye svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; }

.vwag-login-status { min-height: 1.1em; font-size: 0.82rem; color: var(--muted); text-align: center; }
.vwag-login-status.error   { color: var(--danger); }
.vwag-login-status.success { color: var(--brand-bright); }

.vwag-login-submit {
  background: var(--brand); border: none; border-radius: 8px;
  color: var(--on-brand); cursor: pointer; font-weight: 750;
  min-height: 44px; font-size: 0.95rem;
}
.vwag-login-submit:disabled { opacity: 0.6; cursor: default; }

.vwag-login-toggle { text-align: center; font-size: 0.8rem; color: var(--muted); }
.vwag-login-toggle button {
  background: none; border: none; color: var(--brand-bright);
  cursor: pointer; font-size: 0.8rem; padding: 0; text-decoration: underline;
}

.top-action.vwag-logged-in svg { stroke: var(--brand-bright); }
`;

const EYE_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;

const LOGIN_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>`;

const USER_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`;


// ── injected DOM ─────────────────────────────────────────────────────────────

let btn, dialog, statusEl, submitBtn, toggleBtn, toggleText,
    userInput, emailInput, pwInput, emailField, headingSubtitle;
let mode = "login";   // "login" | "register"

function _injectStyles() {
  const el = document.createElement("style");
  el.id = "vwag-login-styles";
  el.textContent = STYLES;
  document.head.appendChild(el);
}

function _injectButton() {
  const bar = document.querySelector(".top-actions");
  if (!bar) return false;
  btn = document.createElement("button");
  btn.id = "vwagLoginBtn";
  btn.type = "button";
  btn.className = "top-action";
  bar.appendChild(btn);
  btn.addEventListener("click", _onButtonClick);
  return true;
}

function _injectDialog() {
  dialog = document.createElement("dialog");
  dialog.id = "vwagLoginDialog";
  dialog.className = "vwag-login-dialog";
  dialog.innerHTML = `
    <form id="vwagLoginForm">
      <div class="vwag-login-brand">
        <p class="wordmark">Victen Worhl</p>
        <p class="subtitle" id="vwagLoginSubtitle">Adventure Game</p>
      </div>
      <div class="vwag-login-field">
        <label for="vwagLoginUser">Username</label>
        <input id="vwagLoginUser" type="text" autocomplete="username" autocapitalize="off" spellcheck="false">
      </div>
      <div class="vwag-login-field hidden" id="vwagLoginEmailField">
        <label for="vwagLoginEmail">Email</label>
        <input id="vwagLoginEmail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false">
      </div>
      <div class="vwag-login-field">
        <label for="vwagLoginPw">Password</label>
        <div class="vwag-login-pw">
          <input id="vwagLoginPw" type="password" autocomplete="current-password">
          <button type="button" class="vwag-login-eye" id="vwagLoginEye" title="Show password" aria-label="Show password">${EYE_ICON}</button>
        </div>
      </div>
      <p class="vwag-login-status" id="vwagLoginStatus"></p>
      <button type="submit" class="vwag-login-submit" id="vwagLoginSubmit">Sign In</button>
      <p class="vwag-login-toggle" id="vwagLoginToggleWrap">
        <span id="vwagLoginToggleText">Don't have an account?</span>
        <button type="button" id="vwagLoginToggle">Sign Up</button>
      </p>
    </form>
  `;
  document.body.appendChild(dialog);

  statusEl        = dialog.querySelector("#vwagLoginStatus");
  submitBtn       = dialog.querySelector("#vwagLoginSubmit");
  toggleBtn       = dialog.querySelector("#vwagLoginToggle");
  toggleText      = dialog.querySelector("#vwagLoginToggleText");
  userInput       = dialog.querySelector("#vwagLoginUser");
  emailInput      = dialog.querySelector("#vwagLoginEmail");
  pwInput         = dialog.querySelector("#vwagLoginPw");
  emailField      = dialog.querySelector("#vwagLoginEmailField");
  headingSubtitle = dialog.querySelector("#vwagLoginSubtitle");

  dialog.querySelector("#vwagLoginForm").addEventListener("submit", _onSubmit);
  toggleBtn.addEventListener("click", _toggleMode);
  dialog.querySelector("#vwagLoginEye").addEventListener("click", _toggleEye);
}


// ── UI behavior ──────────────────────────────────────────────────────────────

function _setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "vwag-login-status" + (kind ? ` ${kind}` : "");
}

function _setMode(next) {
  mode = next;
  const reg = mode === "register";
  emailField.classList.toggle("hidden", !reg);
  submitBtn.textContent  = reg ? "Create Account" : "Sign In";
  toggleText.textContent = reg ? "Have an account?" : "Don't have an account?";
  toggleBtn.textContent  = reg ? "Sign In" : "Sign Up";
  headingSubtitle.textContent = reg ? "Create your account" : "Adventure Game";
  pwInput.autocomplete = reg ? "new-password" : "current-password";
  _setStatus("");
}

function _toggleMode() { _setMode(mode === "login" ? "register" : "login"); }

function _toggleEye() {
  const showing = pwInput.type === "text";
  pwInput.type = showing ? "password" : "text";
  const eye = dialog.querySelector("#vwagLoginEye");
  eye.title = showing ? "Show password" : "Hide password";
  eye.setAttribute("aria-label", eye.title);
}

function _refreshButton() {
  if (!btn) return;
  if (isLoggedIn()) {
    btn.innerHTML = USER_ICON;
    btn.classList.add("vwag-logged-in");
    btn.title = `Logged in as ${getUsername()} — click to log out`;
  } else {
    btn.innerHTML = LOGIN_ICON;
    btn.classList.remove("vwag-logged-in");
    btn.title = "Log in to Victen Worhl";
  }
  btn.setAttribute("aria-label", btn.title);
}

function _onButtonClick() {
  if (isLoggedIn()) {
    if (confirm(`Log out ${getUsername()}?`)) logout();
    return;
  }
  _setMode("login");
  userInput.value = "";
  emailInput.value = "";
  pwInput.value = "";
  pwInput.type = "password";
  dialog.showModal();
  userInput.focus();
}

async function _onSubmit(e) {
  e.preventDefault();
  const username = userInput.value.trim();
  const password = pwInput.value;
  const email    = emailInput.value.trim();

  if (!username || !password || (mode === "register" && !email)) {
    _setStatus("Please fill in every field.", "error");
    return;
  }

  submitBtn.disabled = true;
  _setStatus(mode === "register" ? "Creating account…" : "Signing in…");

  const result = mode === "register"
    ? await register(username, email, password)
    : await login(username, password);

  submitBtn.disabled = false;

  if (!result.ok) {
    _setStatus(result.error, "error");
    return;
  }

  _setStatus(`Welcome, ${result.username}!`, "success");
  _refreshButton();
  setTimeout(() => dialog.close(), 500);
}


// ── init ─────────────────────────────────────────────────────────────────────

function init() {
  if (IS_PLAYER) return;            // GM view only
  _loadStored();
  _injectStyles();
  if (!_injectButton()) return;     // no toolbar (unexpected) → bail quietly
  _injectDialog();
  _refreshButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
