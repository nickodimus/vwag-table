/* backup.js — automatic library backup to a real folder on disk.
 *
 * Owns: the backup folder handle (picked once, persisted in IndexedDB), the 30-minute backup
 * timer, the timestamped-file rotation, and the backup status other code renders. Also owns
 * buildLibraryPayload(), the single definition of "the whole library as one JSON object" — the
 * manual Export button uses it too, so a backup and an export are byte-identical by construction.
 *
 * Does NOT own: the Export/Import buttons (main.js wires those), any UI chrome beyond reporting a
 * status string, or the map records themselves (db.js).
 *
 * WHY A FOLDER AND NOT ANOTHER STORE: the threat is origin eviction. The browser may drop this
 * origin's IndexedDB wholesale under storage pressure, taking every map with it. A backup kept in
 * IndexedDB would be evicted alongside the thing it is backing up — it would defend against
 * nothing. Only bytes written OUTSIDE the browser survive, which means the File System Access API
 * (Chrome). Once the folder is granted, writes need no further prompt.
 *
 * WHEN THE SAFETY NET IS DOWN, SAY SO. Chrome drops the directory permission on some restarts. A
 * backup system that silently stops backing up is worse than none, because it buys false calm — so
 * a revoked or missing permission is a visible status, never a silent no-op.
 *
 * SECURE CONTEXT, AND THE 0.0.0.0 TRAP. showDirectoryPicker only exists in a secure context.
 * http://localhost:8000 is one; http://0.0.0.0:8000 is NOT — same server, same browser, same app,
 * but the API is simply absent and every backup silently degrades to "unsupported". Serve and
 * browse via localhost. The status text names this, because the failure is otherwise indisting-
 * uishable from an unsupported browser.
 */

import { APP_NAME, SAVE_FILE_VERSION } from "./state.js";
import {
  listSessionRecords, listModuleRecords, getImageRecord, getSetting, putSetting,
} from "./db.js";

const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes, and only when something changed
const BACKUP_KEEP = 10;                    // keep the newest 10; older ones are rotated out
const HANDLE_KEY = "backupDir";
const FILE_PREFIX = "vwag-library-";

let dirHandle = null;
let timer = null;
let dirty = false;      // library changed since the last successful backup — no change, no write
let status = { state: "unsupported", detail: "", lastAt: null };
const listeners = [];

function supported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// Distinguish "this browser can't" from "this URL can't" — they look identical (the API is just
// absent) but only one is fixable by the GM, and telling a Chromium user to get Chromium is useless.
function unsupportedReason() {
  if (!window.isSecureContext) {
    return "Automatic backups need a secure context — open the app at http://localhost:8000, not 0.0.0.0.";
  }
  return "Automatic backups need a Chromium-based browser. Use Export to save a copy by hand.";
}

function setStatus(state, detail = "") {
  status = { ...status, state, detail };
  listeners.forEach((fn) => fn(getBackupStatus()));
}

function getBackupStatus() {
  return { ...status };
}

function onBackupStatus(fn) {
  listeners.push(fn);
  fn(getBackupStatus());
}

// Any library write marks us dirty; the timer only writes a backup when this is set, so an idle
// table does not churn out ten identical files.
function markLibraryDirty() {
  dirty = true;
}

/* ------------------------------- the payload ------------------------------- */

// The whole library as one self-contained JSON object: every module, every session, and every
// image blob they reference (images live in their own store, so an export without them would
// restore to a library of blank maps).
async function buildLibraryPayload() {
  const sessions = await listSessionRecords();
  const modules = await listModuleRecords();
  const imageIds = new Set();
  modules.forEach((module) => (module.floors || []).forEach((floor) => {
    if (floor.imageId) imageIds.add(floor.imageId);
  }));
  const images = [];
  for (const imageId of imageIds) {
    const record = await getImageRecord(imageId);
    if (record) images.push(record);
  }
  return {
    app: APP_NAME,
    version: SAVE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    modules,
    sessions,
    images,
  };
}

/* ------------------------------- permission ------------------------------- */

// queryPermission tells us whether the stored handle is still usable WITHOUT prompting. Chrome
// drops the grant on some restarts, which is exactly the case that must surface in the UI rather
// than fail quietly at the next timer tick.
async function handleUsable(handle) {
  if (!handle?.queryPermission) return false;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

// requestPermission needs a user gesture, so this is only ever called from a click.
async function requestHandlePermission(handle) {
  if (!handle?.requestPermission) return false;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/* -------------------------------- writing --------------------------------- */

async function writeBackupFile(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${FILE_PREFIX}${stamp}.json`;
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload));
  await writable.close(); // the write only lands on close — failures surface here, so let them throw
  return name;
}

// Keep the newest BACKUP_KEEP files; delete the rest. Names are ISO-stamped, so lexical sort is
// chronological. Only our own prefix is ever touched — the folder may hold the GM's other files.
async function rotateBackups() {
  const names = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.startsWith(FILE_PREFIX) && name.endsWith(".json")) names.push(name);
  }
  names.sort();
  const stale = names.slice(0, Math.max(0, names.length - BACKUP_KEEP));
  for (const name of stale) {
    try {
      await dirHandle.removeEntry(name);
    } catch (err) {
      console.warn(`Backup: could not rotate out ${name}:`, err); // a failed delete must not fail the backup
    }
  }
}

// Write one backup now. `force` skips the dirty check (the manual/boot path); the timer passes
// nothing, so an unchanged library costs nothing.
async function backupNow({ force = false } = {}) {
  if (!dirHandle) return false;
  if (!force && !dirty) return false;
  if (!(await handleUsable(dirHandle))) {
    setStatus("needs-permission", "Backups paused — folder access was revoked. Click to re-grant.");
    return false;
  }
  try {
    const payload = await buildLibraryPayload();
    const name = await writeBackupFile(payload);
    await rotateBackups();
    dirty = false;
    status.lastAt = new Date();
    setStatus("ready", `Last backup ${status.lastAt.toLocaleTimeString()} (${name})`);
    return true;
  } catch (err) {
    console.error("Backup failed:", err);
    setStatus("error", `Backup failed: ${err.message}`);
    return false;
  }
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { backupNow(); }, BACKUP_INTERVAL_MS);
}

/* --------------------------------- wiring --------------------------------- */

// Ask for the backup folder. Must be called from a click — showDirectoryPicker requires a gesture.
async function chooseBackupFolder() {
  if (!supported()) {
    setStatus("unsupported", unsupportedReason());
    return false;
  }
  try {
    // An existing handle whose permission lapsed just needs re-granting — don't make the GM
    // re-pick the same folder.
    if (dirHandle && !(await handleUsable(dirHandle))) {
      if (await requestHandlePermission(dirHandle)) {
        startTimer();
        await backupNow({ force: true });
        return true;
      }
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "vwag-backup" });
    if (!(await handleUsable(handle)) && !(await requestHandlePermission(handle))) {
      setStatus("needs-permission", "Backups paused — folder access was denied.");
      return false;
    }
    dirHandle = handle;
    await putSetting(HANDLE_KEY, handle);
    startTimer();
    await backupNow({ force: true });
    return true;
  } catch (err) {
    if (err?.name === "AbortError") return false; // the GM closed the picker; not an error
    console.error("Backup: could not set the folder:", err);
    setStatus("error", `Could not set the backup folder: ${err.message}`);
    return false;
  }
}

// Boot: re-adopt the stored folder if its permission survived, back up once, and start the timer.
// If the permission lapsed we do NOT prompt (no gesture, and a modal at boot is hostile) — we
// report it, and the GM's click re-grants.
async function initLibraryBackup() {
  if (!supported()) {
    setStatus("unsupported", unsupportedReason());
    return;
  }
  let stored = null;
  try {
    stored = await getSetting(HANDLE_KEY);
  } catch (err) {
    console.warn("Backup: could not read the stored folder:", err);
  }
  if (!stored) {
    setStatus("off", "No backup folder set — your library is not being backed up.");
    return;
  }
  dirHandle = stored;
  if (!(await handleUsable(stored))) {
    setStatus("needs-permission", "Backups paused — folder access was revoked. Click to re-grant.");
    return;
  }
  startTimer();
  await backupNow({ force: true }); // one at boot, so a session never starts on a stale copy
}

export {
  initLibraryBackup, chooseBackupFolder, backupNow, markLibraryDirty,
  onBackupStatus, getBackupStatus, buildLibraryPayload,
};
