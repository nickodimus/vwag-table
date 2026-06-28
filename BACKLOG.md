# vwag-table backlog

Working tracker for vwag-table. Canonical idea and design list; work is pulled from here.
Shipped items are removed once merged — this file is what's left to do, not a changelog.

## Planned

- **Universal map import** — extend the existing Digital Table Tops (`.dtt`) importer to ingest
  exports from other tools (Foundry VTT, Roll20, Owlbear Rodeo) and the Universal VTT
  (`.dd2vtt`/`.uvtt`) format, mapping their walls, doors, and lights into the obstacle and light
  stores so a downloaded map drops straight into the vision system without hand-drawing.
- **Player-side stair traversal** — let player-controlled tokens traverse stairs from the
  player view, not just from the GM panel.
- **VWAG backend integration** — persist map, token, and fog state alongside campaign data,
  and resolve a token to a real creature record via its link.

## Performance / cleanup

- **Keyboard shortcuts blocked until first focus** — window `keydown` handlers don't fire until
  the page/canvas first receives focus (a click). On a fresh load, or after focus leaves the
  document, keystrokes are swallowed until you click back into the page. Pre-existing input-focus
  issue, surfaced again by the `?` overlay. Likely fix: focus the canvas on load / when a map
  becomes ready, so the keymap is live without an initial click.
- Re-author very large wall polylines into smaller segments so heavy maps stay responsive.
- Event-listener leak audit across the module split.
- Large-map memory handling — cap pixel/file size on load, or chunk very large maps, so the
  browser stays responsive (raised by users on big high-res maps).

## Community-requested (r/DungeonsAndDragons launch thread)

Feature asks pulled from the launch-thread feedback. Most popular asks were already shipped
(player token movement, token editing/conditions, persistent labeled AoE, initiative-token
links, lighting/LOS, bulk token import). These are the net-new ones worth considering:

- **DM PDF reader/organizer** — open rulebooks, stat blocks, character sheets, and handouts as
  floating windows on the GM screen. (Also on the Lodestar copy list.)
- **Token manager / layers panel** — a list of placed tokens you can click to highlight on the
  map; ties into the initiative tracker.
- **Instant bulk token placement** — one step to drop all palette tokens onto the map, beyond
  the existing bulk import.
- **Auto-measure while dragging a token** — show the distance live while moving a token, keeping
  the origin square highlighted until release. Small extension of the existing path/distance trace.
- **Multi-track audio** — play ambience and a sound effect at once, with simple categories. (A
  refinement on the Lodestar music-player copy item.)
- **Animated / video map backgrounds** — support looping video maps, not just static images.
- **Grid line-thickness slider** — thicker grid lines so they don't get lost on large high-res screens.

## Deferred — needs the physical table

- **Multi-cell staircases** — a stair spanning more than one cell. Group traversal already
  works without it, so this only adds a larger trigger zone and cosmetic footprint matching.
  Revisit once the touch table and IR frame are physically set up.
- **Physical mini tracking** — a multi-pointer engine binding infrared touch contacts to
  tokens, so resting miniatures map to on-screen tokens. Build when the hardware exists.

## Lodestar features to port (with author's blessing)

Hand-ported into the modules, not merged. Ordered by value-to-effort:

1. ~~Shortcuts overlay (press `?` for the hotkey list).~~ Shipped (`shortcuts.js`, context-aware GM/player).
2. DM PDF windows (see Community-requested above — same feature).
3. Rich-text notes (upgrade the existing floating notes).
4. Image transform handles (on-canvas resize/rotate for dropped map images).
5. User manual reachable from the start screen.
6. Music player (lowest — external playlists already cover this).

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). This fork has diverged and no longer
  merges cleanly — pull upstream improvements selectively, by hand, when worthwhile.
