# main.js

The orchestrator. ~5,600 lines, imports **19** modules, imported by none. It
owns boot, control wiring, the `BroadcastChannel` message handler, the input
layer, movement/collision, floor/stairs/map-link management, and the app-level
actions that cross-cut multiple feature modules.

It is **large but well-factored** — see the full analysis and the ranked
extraction candidates in [Architecture](../architecture.md). Highlights:

- The biggest single function is `bindControls()` (~573 lines) — irreducible
  DOM→action glue, not a refactor target.
- `hooks` is wired here at boot (`hooks.render`, `hooks.renderAndSync`,
  `hooks.relay`, `hooks.pushHistory`, `hooks.syncPanels`), which is what lets
  every leaf module call up without importing `main.js`.
- The movement/collision code (`resolveMove`, `sweepCircleSeg`, `firstMoveHit`)
  is deliberately inline and **parked** until the physical IR-table hardware
  decision — do not extract it.

## Boot sequence (entry point)

`index.html` loads `main.js` as a module script. On `DOMContentLoaded`, `setup()`
resolves the `controls` map, wires `hooks`, calls `bindControls()`, sets up the
start screen / collapsible sections / player cursor, and installs the pointer,
wheel, and key handlers. The four self-wiring leaf modules (`shortcuts`,
`pdf-windows`, `sandbox`, and `image-handles` via `render.js`) attach their own
`DOMContentLoaded` init independently.

## Cluster map

See the {ref}`cluster table <main-clusters>` in the architecture page.
