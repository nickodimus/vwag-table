/* content.js — the content-resolution layer for vwag-table's map containment trail.
 *
 * Two jobs, kept deliberately separate from the load/apply ACTIONS in main.js (which own
 * live state, rendering and the UI):
 *
 *   1. The RESOLVER — the single seam through which all map content enters the app. Today it
 *      reads the local IndexedDB stores (db.js). In the online ("Willow") chunk, a remote source
 *      registered via registerRemoteSource() adds a fallon tier WITHOUT touching any caller:
 *
 *          resolveModule(id) :  memory  ->  IndexedDB  ->  [remote: fallon]   (cache result down)
 *          resolveImage(id)  :  memory  ->  IndexedDB  ->  [remote: fallon]   (cache result down)
 *          resolveSession(id):  IndexedDB only  (a session is THIS table's play state — always local)
 *
 *      Resolve order is also the off-grid policy: fallon unreachable -> fall through to whatever is
 *      cached locally. The same memory tier that makes the warm trail instant is the offline buffer.
 *      The remote slot defaults empty, so deleting api.js (or playing off-grid) leaves a clean
 *      local-only resolver — nothing here imports api.js; api.js registers itself into the slot.
 *
 *   2. The TRAIL + SNAPSHOT CACHE — a breadcrumb stack of map ids plus the merged+hydrated
 *      snapshot for each map visited this session. descend()/ascend() (main.js) freeze the map
 *      they leave into this cache and thaw the destination out of it, so popping back up the trail
 *      is a render swap, not a reload. Snapshots hold their floor records by reference, so live
 *      edits stay current in the cache for free (see snapshotFromLiveState in persistence.js).
 *
 * IDENTITY RULE (load-bearing for the online chunk): a map is addressed by its record `id`
 * verbatim. Local maps use a name slug; fallon-sourced maps keep fallon's canonical id and are
 * cached down under THAT id, never re-slugged. So a link authored against an id keeps resolving
 * the same map whether it comes from IndexedDB or fallon.
 */

import {
  getModuleRecord, getSessionRecord, getImage, saveModuleRecord, putImage,
} from "./db.js";

// ── resolver caches + remote slot ────────────────────────────────────────────

const moduleCache = new Map(); // id -> module record (resolver memory tier)
const imageCache = new Map();  // imageId -> dataURL (resolver memory tier)

// Remote content source, filled by the online chunk's api.js. Shape:
//   { fetchModule(id) -> record|null, fetchImage(imageId) -> dataURL|null }
// Null = local-only (off-grid / api.js absent). Mutated in place via the registrar below.
let remote = null;

// Register (or clear) the remote tier. Called once by api.js at startup in the online chunk;
// passing null restores local-only resolution.
function registerRemoteSource(source) {
  remote = source || null;
}

// ── resolver ─────────────────────────────────────────────────────────────────

// A session is the local play state for one map — never fetched from fallon.
async function resolveSession(id) {
  return getSessionRecord(id);
}

// memory -> IndexedDB -> remote, caching any remote hit down into both lower tiers so the next
// resolve (and off-grid play) is local.
async function resolveModule(id) {
  if (!id) return null;
  if (moduleCache.has(id)) return moduleCache.get(id);
  let record = await getModuleRecord(id);
  if (!record && remote && typeof remote.fetchModule === "function") {
    try {
      record = await remote.fetchModule(id);
    } catch {
      record = null; // fallon unreachable / not found — fall through to local-only behavior
    }
    if (record) {
      try { await saveModuleRecord(record); } catch { /* cache-down best effort */ }
    }
  }
  if (record) moduleCache.set(id, record);
  return record || null;
}

// memory -> IndexedDB -> remote, same tiering as modules. Returns "" when the image can't be found
// anywhere (callers already tolerate a blank image — applyFloor renders the empty board).
async function resolveImage(id) {
  if (!id) return "";
  if (imageCache.has(id)) return imageCache.get(id);
  let data = await getImage(id);
  if (!data && remote && typeof remote.fetchImage === "function") {
    try {
      data = await remote.fetchImage(id);
    } catch {
      data = "";
    }
    if (data) {
      try { await putImage(id, data); } catch { /* cache-down best effort */ }
    }
  }
  if (data) imageCache.set(id, data);
  return data || "";
}

// ── breadcrumb trail ─────────────────────────────────────────────────────────

const trail = []; // stack of map ids; the last entry is the active map

function trailActiveId() { return trail.length ? trail[trail.length - 1] : null; }
function trailDepth() { return trail.length; }
function trailList() { return trail.slice(); }
function trailPush(id) { trail.push(id); }
function trailPop() { return trail.pop(); }
// Replace the whole trail (used when jumping to a new root; chunk 3's sideways jump builds on this).
function trailReset(id) { trail.length = 0; if (id) trail.push(id); }

// ── warm snapshot cache (the "no reload" tier) ───────────────────────────────

const snapshotCache = new Map(); // mapId -> merged+hydrated snapshot (floors held by reference)

function cacheHas(id) { return snapshotCache.has(id); }
function cacheGet(id) { return snapshotCache.get(id) || null; }
function cacheSet(id, snapshot) { snapshotCache.set(id, snapshot); }
// Drop everything warm (e.g. when starting a fresh library) — also clears the resolver memory tier.
function cacheClear() {
  snapshotCache.clear();
  moduleCache.clear();
  imageCache.clear();
}

export {
  registerRemoteSource,
  resolveSession, resolveModule, resolveImage,
  trailActiveId, trailDepth, trailList, trailPush, trailPop, trailReset,
  cacheHas, cacheGet, cacheSet, cacheClear,
};
