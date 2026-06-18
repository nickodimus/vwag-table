# vwag-table backlog

Working tracker for vwag-table (the VWAG VTT, forked from Lodestar). Canonical idea
and design list; chunks are pulled from here.

## Done

- **Chunk 0** — fork stood up, `baseline-upstream` tag, fork README.
- **Chunk 1** — player display moves tokens by touch, synced to the GM; GM authoritative.
- **Chunk 2** — live drag streaming; authoritative snap; `touch-action: none` on the map.
- **Token labels** — 12-char cap, auto-fit shrink; image-token labels render *below* the
  token so the art stays visible; color-token labels stay centered. Shared helper.
- **Token type** — `player` / `npc` / `monster` set at creation; color-coded ring
  (player green, npc blue, monster red) on GM + player views.
- **Token edit** — select-to-edit panel (Selected Token section) for type/label/color/size,
  live + synced, mirroring the image/note selection-panel pattern.
- **Initiative import + link** — "Add board tokens" pulls every token into the tracker as a
  linked combatant (name from label or auto-named by type; type carried over; `tokenId`
  link; deduped). Deleting a token removes its linked combatant (turn pointer re-clamped);
  manual combatants are untouched; the link is one-way (removing a row never deletes a mini).

## Next — turn pointer highlights the linked token

Build on the `tokenId` link: advancing the turn (next/prev/set-turn) highlights and centers
the active combatant's token on the board and the player display, so the initiative order
is visibly tied to the table. Uses the link that the import chunk just established.

## Feature backlog

- **Token library** — quick-add palette of saved presets (name, type, color, image, size);
  persist locally via IndexedDB, later via fallon.
- **Lighting system** — its own scoping pass. Simple darkness/reveal layers (modest) vs full
  line-of-sight + light sources + vision blocking (large). Decide the flavor before code.
- **Live-add to initiative** (optional) — layer onto the import: auto-add a combatant when a
  token is placed, giving Path A's always-live feel on top of Path B.
- **GM-only type rings** (optional) — gate the type ring so players don't see token type.

## Future stage — VWAG stat import

Import players / NPCs / monsters straight from VWAG (MySQL on fallon) and auto-populate
combatant stats (HP, etc.) through the `tokenId` link the initiative chunk established. This
is the long-game seam VWAG has been built toward: a token on the table resolves to a real
VWAG creature record. Needs the fallon data path (later stage).

## Deferred — physical mini tracking (until the IR frame + TV table are built)

- IR frame reports every resting mini as a persistent contact (15 dev / 20 table); engine
  tracks N simultaneous contacts.
- Turn-based: one mini moves at a time, so identity matching is trivial (the mover is the
  active token; others hold).
- Build: multi-pointer engine (map keyed by `pointerId`) -> contact-to-token binding.
- Open Qs: initial binding method, jitter dead-zone, mixed physical/digital, lift-and-replace.

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). `git fetch upstream` to pull improvements.
- fallon (FastAPI + MySQL) integration is a later stage: persist map / token / fog /
  initiative state with campaign data, and feed the VWAG stat import above.
