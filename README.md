# vwag-table

A local-first, browser-based virtual tabletop for running the Victen Worhl Adventure Game (VWAG) on a physical touch-surface table. It casts a battlemap with fog of war to a player screen while the GM drives everything from a separate panel — and it is being extended to track physical miniatures on an infrared touch frame.

## Fork notice

vwag-table is a fork of [Lodestar](https://github.com/UnclePlants/Lodestar) by UnclePlants, used under the MIT License. The upstream project is a self-contained battlemap caster with fog of war, tokens, an initiative tracker, area-of-effect templates, multi-floor maps, and grid and measure tools, all in dependency-free HTML/CSS/JS with no build step. All original authorship remains credited: the upstream `LICENSE` and `CREDITS.md` are retained unchanged.

For the full feature list and usage of the base application, see the [upstream Lodestar README](https://github.com/UnclePlants/Lodestar#readme).

## What this fork adds

vwag-table adapts Lodestar into the VTT component of VWAG, a custom tabletop RPG system. Planned divergence from upstream:

- Touch-driven token control on the player display, so tokens can be moved by touching the table rather than only from the GM panel.
- Multi-touch tracking of several simultaneous contacts, working toward mirroring physical miniatures on a 20-point infrared touch frame.
- Integration with the VWAG backend (FastAPI and MySQL on the `fallon` server), so map, token, and fog state can persist alongside campaign data.

The `baseline-upstream` git tag marks the pristine Lodestar starting point; `git diff baseline-upstream` shows all VWAG-specific changes.

## Running

No build step and no dependencies. Serve the folder over HTTP (not `file://`, so the player window and clipboard behave):

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`, load a map image, and click "Open player display" to cast to a second screen.

## License

MIT — see [LICENSE](LICENSE). Bundled icons and demo artwork retain their original licenses; see [CREDITS.md](CREDITS.md).
