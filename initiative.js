/* initiative.js — the turn tracker's read + render layer.
 * Sorts combatants, answers whose turn it is, builds the GM panel and the player overlay DOM.
 * Data lives in state.initiative (synced); this module only reads it and renders. The mutators
 * (add/remove/adjust/step/reset) and the click delegation that drives them stay in app.js until
 * the input/sync layer at step 14. Redraws go through hooks.render.
 */

import {
  canvas, controls, isPlayer, hooks, escapeHtml, state, shell,
} from "./state.js";

// Turn order: highest initiative first. JS sort is stable, so ties keep insertion order.
function sortedCombatants() {
  return [...state.initiative.combatants].sort((a, b) => b.init - a.init);
}

// The token (if any) of the combatant whose turn it currently is — drives the active-turn
// highlight on both screens. Null when initiative is off/empty or the combatant has no token.
function activeTurnTokenId() {
  const init = state.initiative;
  if (!init.active || !init.combatants.length) return null;
  const c = sortedCombatants()[init.turn];
  return c ? c.tokenId || null : null;
}

function clampInitiativeTurn() {
  const n = state.initiative.combatants.length;
  state.initiative.turn = n ? Math.min(Math.max(0, state.initiative.turn), n - 1) : 0;
}

function updateInitiativeUI() {
  if (!isPlayer) renderInitiativePanel();
  renderInitiativeOverlay();
  hooks.render(); // refresh the canvas so the active-turn token highlight tracks the current turn
}

function renderInitiativePanel() {
  const init = state.initiative;
  // Visibility is driven by the grid column width (the `has-initiative` class), which
  // animates open/shut — so we don't toggle the `hidden` attribute here.
  shell.classList.toggle("has-initiative", init.active);
  controls.initToggle?.classList.toggle("active", init.active);
  if (controls.initShowPlayers) controls.initShowPlayers.checked = init.showPlayers;
  if (controls.initShowOverlay) controls.initShowOverlay.checked = init.showOverlay !== false;
  if (controls.initRoundLabel) controls.initRoundLabel.textContent = `Round ${init.round}`;
  if (!controls.initList) return;
  const list = sortedCombatants();
  controls.initList.innerHTML = list
    .map((c, i) => {
      const pct = c.maxHp > 0 ? Math.max(0, Math.min(100, ((c.hp || 0) / c.maxHp) * 100)) : 0;
      return `<div class="init-row${i === init.turn ? " current" : ""}" data-id="${c.id}">
        <div class="init-row-top">
          <span class="init-dot ${c.type}"></span>
          <button type="button" class="init-name" data-act="set-turn" title="Set as current turn">${escapeHtml(c.name)}</button>
          <input class="init-init" type="number" data-field="init" value="${c.init}" title="Initiative">
          <button type="button" class="init-remove" data-act="remove" title="Remove" aria-label="Remove">&times;</button>
        </div>
        <div class="init-hp-line">
          <button type="button" class="init-hp-step" data-act="hp-down" title="Damage 1" aria-label="Damage">&minus;</button>
          <div class="init-hp-bar"><span style="width:${pct}%"></span></div>
          <input class="init-hp-input" type="number" data-field="hp" value="${c.hp ?? ""}" placeholder="–" title="Current HP">
          <span class="init-hp-max">/ ${c.maxHp ?? "–"}</span>
          <button type="button" class="init-hp-step" data-act="hp-up" title="Heal 1" aria-label="Heal">+</button>
        </div>
      </div>`;
    })
    .join("");
  if (!list.length) {
    controls.initList.innerHTML = '<p class="hint">No characters yet. Add one below.</p>';
  }
}

function renderInitiativeOverlay() {
  const ov = controls.initiativeOverlay;
  if (!ov) return;
  const init = state.initiative;
  // The overlay is independent of the docked panel: on the GM it shows when the GM overlay
  // toggle is on and the panel is closed; on the player when the players toggle is on.
  const show = init.combatants.length > 0 && (isPlayer ? init.showPlayers : init.showOverlay !== false && !init.active);
  ov.hidden = !show;
  if (!show) return;
  const list = sortedCombatants();
  const rows = list
    .map((c, i) => {
      const hp = !isPlayer && c.hp != null ? ` <em>${c.hp}${c.maxHp != null ? `/${c.maxHp}` : ""}</em>` : "";
      return `<li class="${i === init.turn ? "current" : ""}"><span class="init-dot ${c.type}"></span><span class="init-ov-name">${escapeHtml(c.name)}</span>${hp}</li>`;
    })
    .join("");
  // GM gets turn arrows + a hide button in the header; the player just sees the round label.
  const head = isPlayer
    ? `<div class="init-ov-round">Round ${init.round}</div>`
    : `<div class="init-ov-head">
        <button type="button" class="init-ov-btn" data-act="ov-prev" title="Previous turn" aria-label="Previous turn">‹</button>
        <span class="init-ov-round">Round ${init.round}</span>
        <button type="button" class="init-ov-btn" data-act="ov-next" title="Next turn" aria-label="Next turn">›</button>
        <button type="button" class="init-ov-btn" data-act="ov-hide" title="Hide overlay" aria-label="Hide overlay">×</button>
      </div>`;
  ov.innerHTML = `${head}<ol>${rows}</ol>`;
}

export {
  sortedCombatants, activeTurnTokenId, clampInitiativeTurn, renderInitiativePanel, renderInitiativeOverlay, updateInitiativeUI,
};
