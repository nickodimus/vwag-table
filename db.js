/* db.js — IndexedDB persistence layer for vwag-table.
 * The raw store access: open/upgrade the database, the generic transaction wrapper, and the
 * CRUD helpers for the maps/modules/sessions/tokens/images stores. Pure — depends only on the
 * store-name constants from state.js, touches no shared mutable state. Snapshot partitioning
 * and migration (the callers of these helpers) stay in app.js until persistence.js.
 */

import {
  DB_NAME, DB_VERSION, MAP_STORE, IMAGE_STORE, MODULE_STORE, SESSION_STORE, TOKEN_STORE, SETTINGS_STORE,
} from "./state.js";

function openMapDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MAP_STORE)) {
        db.createObjectStore(MAP_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MODULE_STORE)) {
        db.createObjectStore(MODULE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(TOKEN_STORE)) {
        db.createObjectStore(TOKEN_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Generic IndexedDB transaction wrapper — all four stores (maps/images/modules/sessions) run
// through this so the boilerplate lives in one place.
async function withStore(storeName, modeName, action) {
  const db = await openMapDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, modeName);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

// Legacy single-record map store — read-only in practice now; kept only so the v4->v5 migration
// can drain it into modules + sessions. (Dropping the store + these helpers is a backlog cleanup
// for once every library has been migrated.)
function saveMapRecord(record) {
  return withStore(MAP_STORE, "readwrite", (store) => store.put(record));
}
function listMapRecords() {
  return withStore(MAP_STORE, "readonly", (store) => store.getAll());
}
function deleteMapRecord(id) {
  return withStore(MAP_STORE, "readwrite", (store) => store.delete(id));
}

// Module store — authored maps (shareable, /maps/-ready).
function saveModuleRecord(record) {
  return withStore(MODULE_STORE, "readwrite", (store) => store.put(record));
}
function listModuleRecords() {
  return withStore(MODULE_STORE, "readonly", (store) => store.getAll());
}
function getModuleRecord(id) {
  return withStore(MODULE_STORE, "readonly", (store) => store.get(id));
}
function deleteModuleRecord(id) {
  return withStore(MODULE_STORE, "readwrite", (store) => store.delete(id));
}

// Session store — per-play state referencing a module by id. The library lists these.
function saveSessionRecord(record) {
  return withStore(SESSION_STORE, "readwrite", (store) => store.put(record));
}
function listSessionRecords() {
  return withStore(SESSION_STORE, "readonly", (store) => store.getAll());
}
function getSessionRecord(id) {
  return withStore(SESSION_STORE, "readonly", (store) => store.get(id));
}
function deleteSessionRecord(id) {
  return withStore(SESSION_STORE, "readwrite", (store) => store.delete(id));
}

// Token store — reusable token templates for the palette (art + color/type/size/torch).
function saveTokenRecord(record) {
  return withStore(TOKEN_STORE, "readwrite", (store) => store.put(record));
}
function listTokenRecords() {
  return withStore(TOKEN_STORE, "readonly", (store) => store.getAll());
}
function deleteTokenRecord(id) {
  return withStore(TOKEN_STORE, "readwrite", (store) => store.delete(id));
}

// Settings store — app-level key/value. Holds the backup folder's FileSystemDirectoryHandle, which
// IndexedDB can structured-clone but localStorage cannot serialize.
function putSetting(id, value) {
  return withStore(SETTINGS_STORE, "readwrite", (store) => store.put({ id, value }));
}
async function getSetting(id) {
  const record = await withStore(SETTINGS_STORE, "readonly", (store) => store.get(id));
  return record ? record.value : null;
}
function deleteSetting(id) {
  return withStore(SETTINGS_STORE, "readwrite", (store) => store.delete(id));
}

/* ----------------------------- image store (de-embedded map images) ----------------------------- */

// Map images live once in their own store keyed by imageId, so a record carries only the
// reference (imageId) rather than the base64 bytes.
function putImage(id, data) {
  return withStore(IMAGE_STORE, "readwrite", (store) => store.put({ id, data }));
}
function getImageRecord(id) {
  return withStore(IMAGE_STORE, "readonly", (store) => store.get(id));
}
async function getImage(id) {
  const record = await getImageRecord(id);
  return record ? record.data : "";
}

export {
  openMapDatabase, withStore, saveMapRecord, listMapRecords, deleteMapRecord, saveModuleRecord, listModuleRecords, getModuleRecord,
  deleteModuleRecord, saveSessionRecord, listSessionRecords, getSessionRecord, deleteSessionRecord, saveTokenRecord, listTokenRecords, deleteTokenRecord,
  putImage, getImageRecord, getImage, putSetting, getSetting, deleteSetting,
};
