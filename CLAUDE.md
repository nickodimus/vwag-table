# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vwag-table` is a local-first virtual tabletop: vanilla JavaScript, ES modules, **no build step, no runtime dependencies, no package manager**. The app is served as static files. It is a fork of [Lodestar](https://github.com/UnclePlants/Lodestar) that has diverged; upstream changes are hand-ported, never merged.

## Commands

Run the app (must be HTTP, not `file://`, or the player window and clipboard break):

```bash
python3 -m http.server 8000
```

- GM view: `http://localhost:8000`
- Player view: `http://localhost:8000/?view=player` (or the **Open player display** button)

There is **no test suite, no linter, and no build**. The only static check available is an ES-module syntax check — plain `node --check` fails on ES modules, so copy to `.mjs` first:

```bash
cp file.js /tmp/c.mjs && node --check /tmp/c.mjs
```

That is syntax-only. **The real validator is a cross-window browser test**: open the GM view and the player view side by side and exercise the change in both. Verify any nontrivial change that way before committing.

**Stale-tab discipline.** After any deploy or local change, hard-refresh **both** the GM and the player tab using **Empty Cache and Hard Reload**. Never use **Clear Site Data** — it wipes IndexedDB and destroys the stored map library. A stale tab produces convincing fake bugs; rule it out before debugging anything.

Docs (isolated Python toolchain, never touches the app runtime):

```bash
cd docs
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
sphinx-build -b html source build/html   # a bad mermaid diagram fails the build
```

Built HTML under `docs/build/html/` is committed.

## Architecture

The full architecture write-up lives in `docs/source/` (`architecture.md`, `data-flow.md`, `coordinate-model.md`, `modules/`). Read those before making structural claims — they were written source-first and are kept in lockstep with the code. The essentials:

**One orchestrator over a layered acyclic module graph.** `state.js` is the root (imports nothing, imported by everything) → `geometry.js` (pure math) and `db.js` (IndexedDB) → feature modules → the aggregators `render.js` (draws) and `sync.js` (broadcasts) → `main.js` (orchestrates, ~5,600 lines, imported by nothing). `render.js` and `main.js` never import each other; they meet only through `state.js`.

**`main.js` is large but not bloated.** Its biggest block is `bindControls()` (~573 lines) — irreducible DOM-to-action glue. Do not "clean it up" reflexively. `docs/source/architecture.md` ranks the extraction candidates; the movement/collision code (`resolveMove`, `sweepCircleSeg`, `firstMoveHit`) is **deliberately inline** and parked until real-session data on the actual hardware shows what's needed. (The TV and IR frame are on hand as of July 2026 — the blocker is no longer the hardware's existence but play at the table telling us what to change.)

**Three patterns keep the graph acyclic — use them, don't work around them:**
- **`hooks` object** (in `state.js`): leaf feature modules call app-level actions (`render`, `renderAndSync`, `relay`, `pushHistory`, `syncPanels`) via `hooks.*`, wired once at boot. This is what lets leaf modules avoid importing `main.js`.
- **`controls` map** (in `state.js`): every DOM control is resolved once by id; modules read `controls.x` instead of re-querying the DOM.
- **Leaf-module pattern**: self-contained modules (`sandbox`, `shortcuts`, `image-handles`, `pdf-windows`, `token-arrows`, `notes-panel`) own their own DOM/draw plus event wiring and import only from `state.js` and `geometry.js`.

**GM is authoritative.** The player display is a second window running the same code, gated by `isPlayer` / `isSandbox` from `state.js`. The GM renders locally and broadcasts a sanitized view over `BroadcastChannel` (and to the online relay when connected). Player token drags are clamped and rebroadcast by the GM.

**State mutation rule:** everything exported from `state.js` is either immutable or **mutated, never reassigned** across a module boundary — reassigning would break ES-module live bindings.

## Coordinate model — the main trap

Three spaces: **native** (source-image pixels, the canonical stored space), **cell** (grid squares, `native ÷ pxPerCellNative`, where gameplay logic lives), and **screen** (client pixels under the current pan/zoom/rotation, only for hit-testing and drawing). All conversions live in `geometry.js` — **never hand-roll a transform in another module.**

Import formats disagree on units, and each parser converts to **cells** before handing off to the shared, unit-agnostic installer `map-import.installParsedMap`:

- **DTT stores distances in feet** (positions in cells). `dtt.normalizeDtt` divides light radii and token size/torch radii by 5 (a bare literal, not a named constant). This has been cross-checked end to end and is correct — **do not re-investigate it.** The chain: parser ÷5 → cells → `installParsedMap` × `pxPerCellNative()` → native px, which is exactly what `vision.js` reads and what the in-app Light tool stores. The tell that DTT distances are feet is token `size` defaulting to 5 (÷5 = 1 cell, a Medium creature); a cells-native default would be 1.
- **Universal VTT stores everything in cells**, including light `range`. `parse-uvtt.js` does **no** ÷5. Applying the DTT feet rule here makes UVTT lights 5× too small — this is the exact trap the parser split exists to prevent.

Adding an import format means writing a parser that emits the shared content shape (obstacles / lights / tokens / notes, in cells) — never touching the installer.

## Conventions

- **No dependencies added to the app runtime.** Ever. Sphinx's Python deps live in `docs/requirements.txt`, isolated under `docs/`.
- **Lockstep docs.** When a module changes materially, update its page under `docs/source/modules/` in the same change. Same rule the README follows for user-facing features.
- **Source-first.** Read the actual code before any claim about a module, export, or data flow.
- Every module opens with a block comment stating what it owns and what it deliberately does *not* own. Match that when adding one.
- `BACKLOG.md` is the canonical work list, not a changelog — shipped items are deleted from it, not marked done.

## Git flow

One chunk = one branch = one issue. Branches are named `chunk-<slug>` and merged with `--no-ff`:

```bash
git fetch && git reset --hard origin/main
git checkout -b chunk-<slug>
# make the change, verify in the browser (GM + player windows)
git add <files> && git commit -m "<message>"
git checkout main && git merge --no-ff chunk-<slug>
git push
```

Pushing to the public repo auto-deploys: a cron `git pull` on **fallon** (the Raspberry Pi) picks up `main` within ~5 minutes and serves it at **game.worhl.net**. Production is a physical living-room table — a 43-inch TV with an IR touch frame — so a merged change alters what players touch at the table shortly after the push. There is no staging step between `git push` and the table.
