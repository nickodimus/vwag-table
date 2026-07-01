# state.js

The root of the dependency graph: `state.js` imports nothing and is imported by
everything. It is the single source of truth for live state, DOM handles, and
constants, plus the two indirection mechanisms (`hooks`, `controls`) that keep
the rest of the graph acyclic.

## What it owns

- **Canvas + context handles** — every drawing layer: `canvas`/`ctx`,
  `fogCanvas`/`fogCtx`, `liveCanvas`, `polyCanvas`, `strokeCanvas`, `losCanvas`,
  `darkCanvas`, `lightCanvas`, `tintCanvas` and their 2D contexts.
- **Live state** — `state` (the mutable app state), `emptyState`, `scene`,
  `sel` (selection), `cur` (current in-progress action), `tools`, `ui`,
  `playerCam`, caches (`exploredMasks`, `lightCache`, `castCache`,
  `castFrameKeys`, `lightFrameKeys`, `fogBuf`).
- **Constants** — DB names/versions (`DB_NAME`, `MAP_STORE`, `IMAGE_STORE`,
  `MODULE_STORE`, `SESSION_STORE`, `TOKEN_STORE`), `FEET_PER_CELL`,
  `MEASURE_UNITS`, `HISTORY_LIMIT`, `FOG_MAX_EDGE`, stairs icons, map-link icons,
  `CONDITIONS`, `PING_DURATION`, `PLAYER_FRAME_REF`.
- **Role flags** — `isPlayer`, `isSandbox`, `DEFAULT_GM_FOG_OPACITY`.
- **Utilities** — `uuid`, `escapeHtml`, `normalizeInput`, `makeFloor`,
  `INITIAL_FLOOR_ID`.
- **`controls`** — the map of every DOM control, resolved once via
  `getElementById`. Modules read `controls.x` rather than re-querying the DOM.
- **`hooks`** — app-level actions that leaf modules call *up* into
  (`render`, `renderAndSync`, `relay`, `pushHistory`, `syncPanels`), wired once
  at boot in `main.js`. This is what lets feature modules avoid importing
  `main.js`, keeping the graph acyclic.

## Why it matters

Every pattern in [Architecture](../architecture.md#patterns) is anchored here:
the `hooks` object, the `controls` map, and the `isPlayer`/`isSandbox` role
gates all live in `state.js`. Changing the shape of `hooks` or `controls`
ripples through every leaf module, so treat this file as the codebase's contract.
