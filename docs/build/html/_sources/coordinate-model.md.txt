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

## The feet ÷ 5 convention

DTT map data stores **distances in feet** but **positions in cells**. One cell =
5 feet (`FEET_PER_CELL`), so any radius or distance coming from a `.dtt` file is
divided by 5 to get cells. This is documented in a comment block in `dtt.js`,
has been cross-checked, and is **correct** — do not re-investigate it. Light and
token radii from imported maps follow this rule.
