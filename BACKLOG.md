# vwag-table backlog

Working tracker for vwag-table (the VWAG VTT, forked from Lodestar). Canonical idea
and design list; chunks are pulled from here.

## Done

- **Chunk 0** — fork stood up, `baseline-upstream` tag, fork README.
- **Chunk 1** — player display moves tokens by touch, synced to the GM; GM authoritative.
- **Chunk 2** — live drag streaming; authoritative snap; `touch-action: none` on the map.
- **Token labels** — 12-char cap, auto-fit shrink; image-token labels render below the token;
  color-token labels centered. Shared helper.
- **Token type** — player/npc/monster set at creation; color-coded ring (player green, npc
  blue, monster red) on GM + player views.
- **Token edit** — select-to-edit panel (Selected Token section) for type/label/color/size.
- **Initiative import + link** — "Add board tokens" pulls tokens in as linked combatants
  (tokenId link, deduped, auto-named); deleting a token removes its linked combatant; manual
  combatants untouched; link is one-way.
- **Move-mode token drag** — click-drag a token in Move mode moves + snaps it (standard VTT);
  a plain click still selects (edit panel + arrow-nudge). Previously drag only worked in the
  Token tool.

## Bugs / watch

- **Player touch drags only one cell (mouse is fine).** Signature of the browser reclaiming a
  finger drag as a scroll. `touch-action: none` on `#battlemap` is present in `styles.css`, so
  the live cause is almost certainly a stale cached `styles.css` in the separate player window.
  Fix: hard-refresh the player window (the GM window gets refreshed but the player one often
  doesn't); confirm `#battlemap` shows `touch-action: none` in the player window's computed
  styles. Escalate to the touch pointer path only if it persists after a confirmed-fresh CSS.

## Next — turn pointer highlights the linked token

Build on the `tokenId` link: advancing the turn (next/prev/set-turn) highlights and centers
the active combatant's token on the board and the player display, so initiative order is
visibly tied to the table.

## Feature backlog

- **Token library** — quick-add palette of saved presets; persist via IndexedDB, later fallon.
- **Lighting system** — its own scoping pass. Simple darkness/reveal layers vs full
  line-of-sight + light sources. Decide the flavor before code.
- **Live-add to initiative** (optional) — auto-add a combatant when a token is placed.
- **GM-only type rings** (optional) — gate the type ring so players don't see token type.

## Future stage — VWAG stat import

Import players / NPCs / monsters from VWAG (MySQL on fallon) and auto-populate combatant
stats through the `tokenId` link. The long-game seam: a token on the table resolves to a real
VWAG creature record. Needs the fallon data path.

## Deferred — physical mini tracking (until the IR frame + TV table are built)

- IR frame reports every resting mini as a persistent contact (15 dev / 20 table).
- Turn-based: one mini moves at a time, so identity matching is trivial.
- Build: multi-pointer engine (map keyed by `pointerId`) -> contact-to-token binding.
- Open Qs: initial binding, jitter dead-zone, mixed physical/digital, lift-and-replace.

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). `git fetch upstream` to pull improvements.
- fallon (FastAPI + MySQL) integration is a later stage.
