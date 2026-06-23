# vwag-table

A local-first virtual tabletop for in-person play on a touch-surface table. The GM drives a private panel; players see a clean battlemap — with fog, dynamic light, and line-of-sight — cast to a second screen. Built for the Victen Worhl Adventure Game (VWAG) and a table with physical miniatures on an infrared touch frame.

No build step, no dependencies, no account. Vanilla ES modules — serve the folder and go. Runs fully offline.

## Running

Serve the folder over HTTP (not `file://`, so the player window and clipboard behave):

```
python3 -m http.server 8000
```

Open `http://localhost:8000` for the GM view. Click **Open player display** and move that window to your second screen. The player view is also reachable directly at `?view=player`. The two windows stay in sync over `BroadcastChannel`.

## What it does

- **Cast with fog of war** — reveal the map to players from a private GM panel; players never see your notes or controls.
- **Dynamic vision and light** — line-of-sight raycasting, light coverage, and darkness; player tokens are clipped to what's actually visible.
- **Multi-floor maps** — per-floor map, fog, tokens, and stairs; the GM view and the table can track different floors independently. Tokens traverse stairs between floors.
- **Tokens** — type rings (player / NPC / monster), labels, status and condition markers, on-token HP, and an edit panel; touch-driven movement on the player display, synced GM-authoritative.
- **Initiative** — tracker linked to board tokens, with an on-board turn highlight on both views.
- **AoE, grid, measure, rotation** — live spell templates, drag-to-calibrate grid and ruler, and independent GM/player map rotation for reading across a flat table.

## Lineage

vwag-table began as a fork of [Lodestar](https://github.com/UnclePlants/Lodestar) by UnclePlants, used under the MIT License, and has since diverged into its own program aimed at a physical IR touch table and the VWAG backend. It is no longer mergeable with upstream.

Original authorship is retained and credited: the upstream `LICENSE` is preserved, and third-party icon attributions, demo artwork, and community thanks remain in [CREDITS.md](CREDITS.md).

## License

MIT — see [LICENSE](LICENSE). Bundled icons and demo artwork retain their original licenses; see [CREDITS.md](CREDITS.md).
