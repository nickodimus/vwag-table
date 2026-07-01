# Architecture

## The shape of the codebase

`vwag-table` is one orchestrator sitting on top of a clean, acyclic, layered
graph of focused ES modules. `main.js` (~5,600 lines) is the orchestrator:
boot, control wiring, the `BroadcastChannel` message handler, the pointer/key/
wheel input layer, movement/collision, floor/stairs/map-link management, and the
app-level actions that cross-cut multiple feature modules. It imports **20**
modules and is imported by **none**. The other modules total ~6,200 lines and
form a dependency tree beneath it.

**Is `main.js` bloated?** No. It is large but well-factored. The single biggest
thing in it is not movement or rendering — it is **control wiring**:
`bindControls()` alone is ~573 lines, because every DOM control has to be bound
to an app-level action somewhere. That glue is irreducible by nature. The
delicate hot-path code (movement/collision) is only ~220 lines and is
deliberately kept inline (see [below](#extraction-candidates)).

## The layered module graph

`state.js` is the root: it imports nothing and is imported by everything. Above
it sits the pure-math layer (`geometry.js`) and the storage layer (`db.js`),
then the feature modules, then the two aggregators — `render.js` (draws
everything) and `main.js` (orchestrates everything). The two aggregators never
import each other; they meet only through `state.js`.

```{mermaid}
graph TD
  subgraph "Layer 0 — root"
    state["state.js"]
  end
  subgraph "Layer 1 — math + storage"
    geometry["geometry.js"]
    db["db.js"]
  end
  subgraph "Layer 2-3 — feature modules"
    features["vision, fog, tokens, annotations,<br/>rooms-obstacles, aoe-measure, initiative,<br/>content, persistence, api, sync, view,<br/>token-arrows, notes-panel, image-handles"]
  end
  subgraph "Layer 4 — aggregators"
    render["render.js (draw)"]
    mapimport["map-import.js<br/>(shared installer)"]
  end
  subgraph "Layer 5 — format parsers"
    dtt["dtt.js"]
    uvtt["parse-uvtt.js"]
  end
  subgraph "Layer 6 — orchestrator"
    main["main.js"]
  end

  state --> geometry
  state --> db
  geometry --> features
  db --> features
  features --> render
  features --> mapimport
  mapimport --> dtt
  mapimport --> uvtt
  render --> main
  dtt --> main
  uvtt --> main
  features --> main
```

The thing that keeps this graph acyclic is the **`hooks` object** (see
[Patterns](#patterns)): leaf feature modules call back up to app-level actions
without importing `main.js`.

(main-clusters)=
## `main.js` responsibility clusters

`main.js` is heavily sectioned. These are its clusters, by size:

| Cluster | Lines | What it is |
|---|---:|---|
| boot + control wiring | ~933 | `setup`, `bindControls` (~573 lines on its own), `handleMessage` (BroadcastChannel), start screen, player window. *(The in-file banner mislabels this "token palette" — stale comment.)* |
| pointer input | ~884 | `onPointerDown` (~342 lines), `onPointerMove/Up`, `onWheel`, `onDoubleClick`, `onContextMenu`, `onKeyDown`. Hot-path. |
| library / IndexedDB | ~605 | Map/module/session save/list/load/delete against the IndexedDB stores. |
| token palette | ~340 | The real token palette: load/add/use/delete/render/export/import, backed by `TOKEN_STORE`. |
| initiative glue | ~329 | `main.js`-side wiring over `initiative.js`. |
| floor management | ~239 | Floor add/remove/switch. |
| snapshots / sync | ~222 | Snapshot capture + broadcast plumbing. |
| movement collision | ~220 | `resolveMove`, `sweepCircleSeg`, `firstMoveHit`. Hot-path, deliberately inline. |
| map images & notes | ~217 | |
| player movement clock | ~212 | The glide / step-run loop. |

(extraction-candidates)=
## Extraction candidates

Ranked by payoff ÷ risk. "Hot-path" means it touches the delicate glide/
rubber-band movement path that is deferred until physical-hardware testing.

1. **`token-palette.js` — high payoff, low risk. Do first.** The ~340-line
   palette block is self-contained, has a crisp API, is backed by `TOKEN_STORE`,
   and does *not* touch the movement path. It already matches the leaf-module
   shape. Good proof the pattern scales.
2. **`library.js` — medium/medium.** The ~605-line IndexedDB library block.
   Coherent, but straddles `db.js` / `persistence.js` / `sync.js` and feeds the
   boot flow; extract with care so boot ordering isn't disturbed.
3. **`floors.js` — medium/medium.** Floor + stairs + map-links (~430 lines) form
   a natural "multi-floor scene" unit. This area is still moving (stair
   traversal is on the roadmap) — extract after that settles.
4. **Initiative glue — low payoff.** Could fold into `initiative.js`, but it's
   mostly DOM wiring tied to `bindControls`. Low urgency.
5. **`input.js` — high payoff, high risk. Deferred.** The ~884-line input layer
   dispatches to nearly everything and sits on the hot-path input→movement
   chain. Extracting it requires first redistributing its many mutator calls
   into feature modules. Defer until after real-session hardware testing.
6. **movement / collision — do not extract.** Deliberately inline, with an
   in-code comment explaining that the glide loop keeps its own copy so the
   deferred rubber-band path stays untouched. Parked until the 43" IR hardware
   is set up and the movement-model decision is made with real minis.

`bindControls()` is intentionally *not* on this list: its ~573 lines are
irreducible glue. It could be split by panel for readability, but that is
cosmetic, not architectural.

(patterns)=
## Patterns

These are the conventions that make the codebase modular. Name them, use them.

- **Leaf-module pattern.** Self-contained feature modules (`sandbox`,
  `shortcuts`, `image-handles`, `pdf-windows`, `token-arrows`, `notes-panel`)
  own their own DOM/draw plus event wiring and import only from `state.js`
  (and `geometry.js`). They never import `main.js`.
- **The `hooks` object** (in `state.js`). Leaf modules trigger app-level actions
  — `render`, `renderAndSync`, `relay`, `pushHistory`, `syncPanels` — through
  `hooks.*`, wired once at boot. This is the mechanism that keeps the import
  graph acyclic.
- **The `controls` map** (in `state.js`). Every DOM control is resolved once via
  `getElementById`; modules read `controls.x` instead of re-querying the DOM.
- **The render / sync split.** `render.js` draws the local GM canvas; `sync.js`
  broadcasts to the player window (via `BroadcastChannel`) and to the online
  relay. Movement is GM-authoritative.
- **GM vs player role.** `isPlayer` / `isSandbox` from `state.js` gate behavior;
  the player display is a second window running the same code.
- **Layered acyclic import graph.** `state` → `geometry`/`db` → feature modules
  → `render`/`sync` → `main`. See the diagram above.
