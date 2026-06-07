# Lodestar

**▶️ [Try it live](https://uncleplants.github.io/Lodestar/)** — runs instantly in your browser, no install.

A local-first battlemap display tool for game masters. Cast a map with fog of war to a second "player" screen while you control everything from a private GM panel. Lodestar runs entirely in the browser with **no build step and no dependencies** — open `index.html` and go. It's structured so it can later be wrapped as a desktop app (Electron, Tauri, or WebView2).

## Screenshots

![Lodestar — GM view (left) with named fog areas, and the player view (right) showing fog of war](screenshot.png)

*GM view on the left with named fog areas ("Chapel", "Library"); the player display on the right shows only what's been revealed.*

> Demo map: "Chapel of the Bountiful Harvest" (#287) by [Elven Tower Adventures](https://elventower.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Modified — fog-of-war overlay added in Lodestar.

## Features

- **Maps** — load high-resolution map images from local disk; pan and zoom freely.
- **Player display** — open a second window, drag it to another screen, and cast the map to your players. The player window can go fullscreen.
- **Fog of war**
  - Trace polygon areas and click them in reveal mode to show/hide on the player display.
  - Name polygon areas with a GM-only label.
  - Paint or erase fog with a round or square brush of adjustable size.
  - GM sees fog as an adjustable tint/opacity; players see solid black.
- **Multi-floor** — build multi-level locations; each floor has its own map, fog, tokens, and stairs. Navigate with the on-screen floor widget.
- **Stairs** — place GM-only staircase markers that link floors; they scale with the grid and zoom and are invisible to players.
- **Tokens** — drop, drag, label, color, and size them in grid cells; they snap to the grid and appear on both displays.
- **Grid** — toggle and adjust size, offset, color, opacity, and token snapping.
- **Ping** — Alt+click draws an animated marker on both displays.
- **Measure** — reports distance in grid cells and feet.
- **Splash / blackout** — show a splash image or a plain black screen on the player display instead of the map.
- **Library** — save full setups (image, grid, fog, tokens, floors, views) to a local IndexedDB library; export/import the whole library as JSON for backups or moving machines.
- **Undo / redo** and **fit-to-screen**.

## Run

Use the **[hosted version](https://uncleplants.github.io/Lodestar/)**, or download the source and open `index.html` in a modern browser — both work identically and run fully offline once loaded. Load a map image, click **Open player display**, and move that window to your second screen (press **F** or double-click for fullscreen).

Use **Save map** to store the full setup in the local library and **My maps** to restore one. Use **Export** / **Import** in the GM panel to back the library up to a file.

## Saving and backups

When you save a map, everything (the image, fog, tokens, floors, grid, and view) is stored in your browser's own local storage (IndexedDB) on your machine. Nothing is ever uploaded to GitHub or anywhere else: the hosted version is just static files with no server behind it, so your maps never leave your computer. Because this storage is tied to a specific browser, device, and site address, a saved library only shows up when you reload from the same place you saved it. Maps saved on the hosted version won't appear if you later open a downloaded copy of `index.html` (a different address), or in a different browser, on another device, or in a private/incognito window. Clearing your browser's site data will also erase the library. For anything you want to keep, use **Export** in the GM panel to save your whole library to a single JSON file you control, then **Import** it wherever you need it. That exported file is the only copy that isn't dependent on a browser setting, so it's the safe way to back up your maps or move them between devices.

## Keyboard shortcuts (GM)

- `V` move · `P` polygon fog · `N` named fog area · `R` reveal · `B` brush · `E` eraser · `T` tokens · `M` measure · `S` stairs
- `F` fit map · `[` / `]` brush size · `Ctrl+Z` undo · `Ctrl+Shift+Z` redo
- Polygon mode: click corners, `Enter` to place, `Esc` to cancel
- `Alt+click` anywhere to ping · right-click a token, polygon, or stair to delete it

## Coordinate model

Fog, rooms, tokens, pings, measures, and stairs are all stored in **native image pixels**, so they stay glued to the map regardless of zoom or the "Map image size" slider. The view is expressed as a centered map point plus a zoom level, which is why **Match GM view** frames the same region on the player screen even though the two windows are different sizes. Fog is rasterized into an offscreen layer capped at 4096px on the long edge to bound memory on very large maps. Older save files are migrated automatically on load.

## Browser support

Tested on current Chromium-based browsers (Chrome, Edge). Requires `BroadcastChannel`, `IndexedDB`, `ResizeObserver`, and Canvas 2D — all standard in modern browsers. The GM and player windows communicate over both `BroadcastChannel` and direct `window.postMessage`, so the cast works even when opened from `file://`.

## Credits

See [CREDITS.md](CREDITS.md) for third-party icon attributions.

## License

Lodestar is released under the [MIT License](LICENSE). Bundled icons are under their respective open-source licenses (see [CREDITS.md](CREDITS.md)).
