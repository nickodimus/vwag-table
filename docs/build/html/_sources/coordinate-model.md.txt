# Coordinate model

`vwag-table` juggles three coordinate spaces. All conversions live in
`geometry.js` — no module should hand-roll its own transform.

## The three spaces

- **Native** — pixels of the source map image, as loaded. The canonical space
  for stored positions. Independent of zoom, pan, or rotation.
- **Cell** — grid squares. `native ÷ pxPerCellNative`. Game distances and most
  gameplay logic work in cells.
- **Screen** — client pixels under the current view transform (pan, zoom,
  rotation). Only for hit-testing pointer events and drawing.

## Key conversions (`geometry.js`)

- `nativeToScreen` / `screenToNative` — cross the view transform.
- `gridCellNative`, `pxPerCellNative`, `nativeToCells`, `cellsToNative` — native
  ↔ cell.
- `tokenRadius`, `cellWorldPx` — sizes in the active space.
- `viewTransform`, `activeView`, `fitScaleFor`, `followView` — build and apply
  the current view.
- `clientToCanvasPoint` — raw pointer event → canvas point (the first step
  before `screenToNative`).

## Per-format distance units

Imported formats disagree on units, so each parser converts to **cells** before
handing off to the shared installer (`map-import.installParsedMap`), which is
unit-agnostic and bakes cells → native px uniformly.

**DTT — feet.** DTT map data stores **distances in feet** but **positions in
cells**. One cell = 5 feet (`FEET_PER_CELL`), so any radius or distance from a
`.dtt` file is divided by 5 to get cells, in `dtt.normalizeDtt`. This is
documented in a comment block in `dtt.js`, has been cross-checked, and is
**correct** — do not re-investigate it. Light and token radii from DTT maps
follow this rule.

**Universal VTT — cells.** UVTT (`.uvtt` / `.dd2vtt` / `.df2vtt`) expresses
everything — wall/portal geometry *and* light `range` — in grid squares
(cells). So `parse-uvtt.js` does **no** ÷5: a light `range` of 5 is 5 cells
directly. Applying the DTT feet rule here would make UVTT lights 5× too small —
the one unit trap this split is designed to prevent. UVTT also carries a
`map_origin` offset (subtracted per point so geometry lands on the image) and
`AARRGGBB` colors (alpha stripped to `#RRGGBB`).
