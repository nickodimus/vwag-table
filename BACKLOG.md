# vwag-table backlog

Working tracker for vwag-table (the VWAG VTT, forked from Lodestar). Canonical idea
and design list; chunks are pulled from here.

## Done

- **Chunk 0** — fork stood up, `baseline-upstream` tag, fork README.
- **Chunk 1** — player display moves tokens by touch, synced to the GM; GM authoritative.
- **Chunk 2** — live drag streaming; authoritative snap; `touch-action: none` on the map.
- **Token labels** — 12-char cap, auto-fit shrink; image-token labels below the token;
  color-token labels centered.
- **Token type** — player/npc/monster at creation; color-coded ring (green/blue/red) on
  both views.
- **Token edit** — select-to-edit panel for type/label/color/size.
- **Initiative import + link** — "Add board tokens" pulls tokens in as linked combatants
  (tokenId, deduped, auto-named); deleting a token removes its linked combatant; manual
  combatants untouched; link is one-way.
- **Move-mode token drag** — click-drag a token in Move mode (standard VTT); click still selects.
- **Touch drag backstop** — `preventDefault` on touch grab + a non-passive `touchmove`
  guard during any drag, so a finger drag can't be stolen as a scroll/cancel on touch
  stacks that don't honor `touch-action` (Chromium/Linux IR panels). Resolves the prior
  "finger drags one cell" bug.
- **Turn highlight** — bright gold ring on the active combatant's linked token, on both the
  GM and player views; tracks next/prev/set-turn/reset. Static (no animation) for the solar
  power budget. No auto-centering by design (would fight the GM's player-view framing).

## Feature backlog

- **Token library** — quick-add palette of saved presets; persist via IndexedDB, later fallon.
- **Lighting system** — its own scoping pass. Simple darkness/reveal layers vs full
  line-of-sight + light sources. Decide the flavor before code.
- **Jump-to-active** (optional) — a deliberate button to center the view on the active token
  (kept separate from the turn highlight so the view never moves on its own).
- **Live-add to initiative** (optional) — auto-add a combatant when a token is placed.
- **GM-only type rings** (optional) — gate the type ring so players don't see token type.

## In progress (analysis)

- **Map-save JSON diff** — compare vwag-table's map-save JSON against the package Digital
  Tabletops produces, to understand format gaps. Pending the two files.

## Future stage — VWAG stat import

Import players / NPCs / monsters from VWAG (MySQL on fallon) and auto-populate combatant
stats through the `tokenId` link. The long-game seam: a token resolves to a real VWAG
creature record. Needs the fallon data path.

## Deferred — physical mini tracking (until the IR frame + TV table are built)

- IR frame reports every resting mini as a persistent contact (15 dev / 20 table).
- Turn-based: one mini moves at a time, so identity matching is trivial.
- Build: multi-pointer engine (map keyed by `pointerId`) -> contact-to-token binding.
- Open Qs: initial binding, jitter dead-zone, mixed physical/digital, lift-and-replace.

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). `git fetch upstream` to pull improvements.
- fallon (FastAPI + MySQL) integration is a later stage.
