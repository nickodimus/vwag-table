/* notes-panel.js — the GM notes drawer: a slide-out inspector for the current floor's notes.
 *
 * A leaf module (DOM/draw only, like image-handles / token-arrows). It owns the drawer's list and
 * editor DOM plus the search filter; the structural actions that need undo history (add / delete /
 * open-close) stay in app.js, which calls refreshNotesPanel() after mutating state.notes.
 *
 * Design that unblocks rich text: a note's `text` is the short LABEL painted on the map pin
 * (unchanged, GM-only canvas). The rich `body` (HTML) is edited and read only here in the DOM — it
 * is never drawn on the canvas, which is exactly what lets rich text exist without a canvas
 * rich-text renderer. `hidden` toggles the pin off the map without deleting the note. All three are
 * GM-only and never broadcast.
 */

import { controls, state, sel, hooks, isPlayer, escapeHtml } from "./state.js";

let query = "";            // current search filter (matches label or plain body text)
let historyArmed = false;  // one undo snapshot per focus session on the label/body fields

// Strip tags to plain text, for search matching and safety scrubbing.
function plainText(html) {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  return d.textContent || "";
}

// A note shows in the list when its label or plain body text contains the query.
function matchesQuery(note) {
  if (!query) return true;
  return ((note.text || "") + " " + plainText(note.body || "")).toLowerCase().includes(query);
}

// Remove scripts, event handlers, and javascript: urls from stored rich HTML before it re-enters
// the editor. Bodies are GM-authored, local, and never broadcast, so this is cheap defense-in-depth.
function sanitizeHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  d.querySelectorAll("script, style, iframe, object, embed").forEach((n) => n.remove());
  d.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      const val = (a.value || "").trim().toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      if ((name === "href" || name === "src") && val.startsWith("javascript:")) el.removeAttribute(a.name);
    });
  });
  return d.innerHTML;
}

// Center the GM view on a note and repaint (GM-only; no broadcast).
function centerOnNote(note) {
  state.view.cx = note.x;
  state.view.cy = note.y;
  hooks.render();
}

// Select a note from the list: sole selection, center on it, sync the View-section panels (so the
// size slider tracks), and repopulate the editor.
function selectNote(note) {
  sel.token = sel.image = sel.stair = sel.mapLink = sel.aoe = null;
  sel.note = note;
  centerOnNote(note);
  hooks.syncPanels();
  refreshNotesPanel();
}

// Load the selected note into the label + rich-body editor, or hide the editor when nothing's picked.
function populateEditor() {
  const ed = controls.notesEditor;
  if (!ed) return;
  const note = sel.note;
  ed.classList.toggle("hidden", !note);
  if (!note) return;
  if (controls.notesLabel) controls.notesLabel.value = note.text || "";
  if (controls.notesBody) controls.notesBody.innerHTML = sanitizeHtml(note.body || "");
}

// Rebuild the (filtered) list and refresh the editor. Called by app.js after any note mutation,
// floor change, or selection change, and internally after edits here.
function refreshNotesPanel() {
  const listEl = controls.notesList;
  if (!listEl) return;
  const notes = state.notes || [];
  listEl.innerHTML = "";
  const shown = notes.filter(matchesQuery);
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "notes-empty";
    empty.textContent = notes.length ? "No notes match your search." : "No notes on this floor yet.";
    listEl.appendChild(empty);
  }
  shown.forEach((note) => {
    const row = document.createElement("div");
    row.className = "notes-row" + (note === sel.note ? " selected" : "") + (note.hidden ? " hidden-note" : "");
    row.dataset.id = note.id;
    const label = (note.text || "").trim() || "(untitled)";
    row.innerHTML =
      `<label class="notes-eye" title="Show this note on the map">` +
      `<input type="checkbox" ${note.hidden ? "" : "checked"} data-role="vis"><span></span></label>` +
      `<button type="button" class="notes-row-label" data-role="pick">${escapeHtml(label)}</button>`;
    listEl.appendChild(row);
  });
  populateEditor();
}

function armHistoryOnce() {
  if (historyArmed) return;
  hooks.pushHistory();
  historyArmed = true;
}

// Bulk show/hide every note on the current floor (one undo step). Operates on the whole floor, not
// just the filtered list, so it's a true "reveal/clear the pins" control.
function setAllHidden(hidden) {
  const notes = state.notes || [];
  if (!notes.length) return;
  hooks.pushHistory();
  notes.forEach((n) => { n.hidden = hidden; });
  hooks.render();
  refreshNotesPanel();
}

// Wire the drawer's own controls once at startup. Structural actions (add/delete/toggle) are wired
// in app.js next to the other tool buttons; this covers search, list interaction, and editing.
function initNotesPanel() {
  if (isPlayer) return; // the player display never shows the GM notes drawer

  controls.notesSearch?.addEventListener("input", () => {
    query = controls.notesSearch.value.trim().toLowerCase();
    refreshNotesPanel();
  });

  controls.notesShowAll?.addEventListener("click", () => setAllHidden(false));
  controls.notesHideAll?.addEventListener("click", () => setAllHidden(true));

  // List via delegation: the label button selects + centers on a note; the eye checkbox toggles
  // its pin (handled on 'change' below).
  controls.notesList?.addEventListener("click", (e) => {
    if (e.target.closest('[data-role="vis"]')) return;
    const row = e.target.closest(".notes-row");
    if (!row) return;
    const note = (state.notes || []).find((n) => n.id === row.dataset.id);
    if (note && e.target.closest('[data-role="pick"]')) selectNote(note);
  });
  controls.notesList?.addEventListener("change", (e) => {
    const vis = e.target.closest('[data-role="vis"]');
    if (!vis) return;
    const row = e.target.closest(".notes-row");
    const note = (state.notes || []).find((n) => n.id === row?.dataset.id);
    if (!note) return;
    hooks.pushHistory();
    note.hidden = !vis.checked; // checked = visible on the map
    hooks.render();
    refreshNotesPanel();
  });

  // Label edits update the map pin live; one undo snapshot per editing session (armed on focus).
  controls.notesLabel?.addEventListener("focus", armHistoryOnce);
  controls.notesLabel?.addEventListener("blur", () => { historyArmed = false; });
  controls.notesLabel?.addEventListener("input", () => {
    if (!sel.note) return;
    sel.note.text = controls.notesLabel.value;
    hooks.render();
    const rowLabel = controls.notesList?.querySelector(`.notes-row[data-id="${sel.note.id}"] .notes-row-label`);
    if (rowLabel) rowLabel.textContent = (sel.note.text || "").trim() || "(untitled)";
  });

  // Rich body (contenteditable), stored sanitized on input; one undo snapshot per session.
  controls.notesBody?.addEventListener("focus", armHistoryOnce);
  controls.notesBody?.addEventListener("blur", () => { historyArmed = false; });
  controls.notesBody?.addEventListener("input", () => {
    if (!sel.note) return;
    sel.note.body = sanitizeHtml(controls.notesBody.innerHTML);
  });

  // Rich-text toolbar. execCommand is deprecated but the only dependency-free way to format a
  // contenteditable across browsers; bold / italic / lists / link is plenty for GM notes.
  controls.notesPanel?.querySelectorAll(".notes-rt-toolbar [data-cmd]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the editor
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd;
      controls.notesBody?.focus();
      if (cmd === "createLink") {
        const url = window.prompt("Link URL:", "https://");
        if (url) document.execCommand("createLink", false, url);
      } else {
        document.execCommand(cmd, false, null);
      }
      if (sel.note) sel.note.body = sanitizeHtml(controls.notesBody.innerHTML);
    });
  });
}

export { initNotesPanel, refreshNotesPanel };
