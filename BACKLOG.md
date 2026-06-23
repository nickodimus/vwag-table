# vwag-table backlog

Working tracker for vwag-table. Canonical idea and design list; work is pulled from here.
Shipped items are removed once merged — this file is what's left to do, not a changelog.

## Planned

- **Persistent labeled AoE** — drop a grid-snapped region (fire, difficult terrain, etc.)
  that stays on the map with a GM label, instead of only the live hover template.
- **Player-side stair traversal** — let player-controlled tokens traverse stairs from the
  player view, not just from the GM panel.
- **VWAG backend integration** — persist map, token, and fog state alongside campaign data,
  and resolve a token to a real creature record via its link.

## Performance / cleanup

- Re-author very large wall polylines into smaller segments so heavy maps stay responsive.
- Event-listener leak audit across the module split.

## Deferred — needs the physical table

- **Multi-cell staircases** — a stair spanning more than one cell. Group traversal already
  works without it, so this only adds a larger trigger zone and cosmetic footprint matching.
  Revisit once the touch table and IR frame are physically set up.
- **Physical mini tracking** — a multi-pointer engine binding infrared touch contacts to
  tokens, so resting miniatures map to on-screen tokens. Build when the hardware exists.

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). This fork has diverged and no longer
  merges cleanly — pull upstream improvements selectively, by hand, when worthwhile.
