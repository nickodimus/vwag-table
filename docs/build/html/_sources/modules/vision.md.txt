# vision.js

Line-of-sight and light raycasting, with a spatial-grid cull to keep it fast.
Consumes wall segments from `rooms-obstacles.js` and produces the visibility and
light polygons that `render.js` composites into the fog and tint layers.

## Public exports

`invalidateCast`, `rayHit`, `castVisibility`, `getVisibilityPolygon`,
`playerVisionPolygons`, `losPath`, `lightSegments`, `lightSources`,
`compositeLightTint`, `getLightPolygon`, `buildLightCoverage`, `hitLight`,
`drawLights`, `compositeLoS`, `getExploredCanvas`, `sightSegments`, `castVersion`.

## Performance note

The cull uses a uniform spatial grid, which reduces per-light ray tests from
roughly `O(6·N²)` toward `O(6·k²)`. After polyline simplification the runtime
segment count is on the order of ~1,873 (not the raw ~8,600). Wall decimation
was investigated and is a **dead optimization** — the spatial grid already does
the work. `castVersion` / `invalidateCast` gate recomputation so vision only
recasts when the scene actually changes.

## Coordinate note

Radii from imported maps are in feet and divided by 5 to reach cells — see
[Coordinate model](../coordinate-model.md).
