# vwag-table map-module framework (proposed)

A target format for vwag-table maps, modeled on Digital Tabletops (DTT) but fitted to
vwag-table's data and to being **generated and served by VWAG** as `/maps/` modules. Design
spec, future work — not a commitment. Grounded in two DTT exports (Caves of Chaos, large
outdoor; Temple of Sages, small interior) and the current vwag-table save.

## Core principle: authored module vs. session state

The single most important split, and the thing the current vwag-table save gets wrong by
mashing everything into one blob:

- **Authored module** — static, read-only, VWAG-generated: the map image, grid, coordinate
  space, occlusion geometry, lights, room labels, spawn points, VWAG linkage. Versioned,
  shareable, replayable. This is what lives under VWAG `/maps/`.
- **Session state** — per-play, disposable/persistable separately: fog progress, token
  instances and positions, current HP/conditions, initiative, view framing, which doors are
  open, current time-of-day. References a module by id.

A module can be replayed fresh by any table; a session is one playthrough of it. vwag-table
loads a module and maintains session state on top, and can persist session state to fallon.

## Package layout

Modeled on DTT's clean file separation (vs. vwag-table's current base64-in-one-JSON):

```
maps/<module-id>/
  module.json     # authored definition (manifest below)
  map.webp        # map image, as an image (not base64)
  thumb.webp      # thumbnail
  geometry.json   # occlusion geometry (walls/doors/etc.) — for future LoS/lighting
```

Session state is NOT in the module. It is its own document (`session.json` on disk, or a row
in fallon) that references `<module-id>`.

Keeping the image as a file (referenced by id), not embedded, is the big win: the sample
vwag-table save is 11.5 MB of mostly base64; the actual scene state is a few KB. VWAG serves
the image once; modules stay tiny.

## Coordinate space

Adopt **cell units** (DTT's model), not pixels. The module declares the grid size in cells
and the image's pixels-per-cell; everything else (geometry, lights, spawns, token sizes,
vision/light radii, speeds) is in cell units. Resolution-independent and game-native.

```json
"grid": { "cellsX": 34, "cellsY": 44, "pxPerCell": 72, "color": "#ffffff", "alpha": 0.25 }
```

(Caves of Chaos was 128x90 @ 100 px/cell; Temple of Sages 34x44 @ 72 px/cell — so px/cell is
per-map, which is exactly why cell units beat pixels.)

## Occlusion geometry — generalized

DTT uses fixed buckets (`walls`, `doors`, `windows`, `objects`, `invisibles`, `ethereals`).
Across the two samples these vary in shape: walls are sometimes 2-point segments, sometimes
multi-point polylines; objects are closed polygons; doors are 2-point segments; windows are
segments. Rather than copy the rigid buckets, use **one list of polylines with behavior
flags** plus a `kind` tag for tooling. One list feeds one casting routine; the tag preserves
"wall tool / door tool" semantics and rendering.

```json
"obstacles": [
  {
    "id": "w12",
    "kind": "wall",          // wall | door | window | object | custom
    "points": [[6.5,32.3],[1.5,32.4],[1.6,30.3]],   // >=2 points; closed if first==last
    "blocksSight": true,
    "blocksLight": true,
    "blocksMove": true,
    "openable": false,       // doors: true
    "defaultOpen": false
  }
]
```

Suggested defaults by kind (overridable):

- **wall** — blocks sight, light, move. Polyline.
- **door** — openable; closed blocks sight/light/move, open passes all. Segment. Session
  tracks open/closed by `id` (cleaner than DTT's `opened` referencing stringified bounds).
- **window** — blocks move, passes sight + light. Segment.
- **object** — closed polygon (furniture/props); blocks sight + move (light optional).
- **custom** — explicit flags (covers DTT's `invisibles` = block, undrawn; `ethereals` =
  reserved).

This is the foundation the comparison doc calls for: a segment/polyline store + a casting
routine, from which line-of-sight, lighting, and raster fog all derive.

## Lights (authored) + ambient

```json
"ambient": { "timeOfDay": 12.0 },          // 0-24 hours; drives global light level
"lights": [
  { "id": "L1", "position": [11.4,28.4], "radius": 10.0, "color": "#ffd9a0", "active": true }
]
```

Per-token light/vision lives on the token instance (session), mirroring DTT's
`bright_radius` / `dim_radius` / `torch_on`.

## Room labels / pins (authored)

```json
"pins": [ { "position": [43.0,83.0], "text": "ENTRANCE J" } ]
```

(DTT `notes` — Caves of Chaos had 82 labeled rooms; Temple of Sages had 0.)

## VWAG linkage (the long-game seam)

The module carries references back into VWAG so a map is not an island:

```json
"vwag": {
  "moduleId": "ea31-temple-of-sages",
  "ea": 31,
  "spawns": [ { "position": [0.0,17.5], "creatureRef": "vwag:creature/sage-acolyte" } ]
}
```

A spawn (or a placed token) can resolve to a real VWAG creature record (HP, speed, vision),
which is the stat-import target. The `tokenId` link vwag-table already has is the runtime
half of this.

## Session state (separate document)

```json
{
  "moduleId": "ea31-temple-of-sages",
  "fog": { "mode": "raster", "persist": true, "mask": "session-fog.webp" },
  "openDoors": ["d3","d7"],
  "timeOfDay": 18.0,
  "tokens": [
    { "id":"t1","instanceOf":"vwag:creature/sage-acolyte","position":[12.0,28.0],
      "hp":20,"type":"player","label":"Player 1","color":"#d6a94d",
      "brightRadius":5,"dimRadius":10,"torchOn":true,"visibility":true }
  ],
  "initiative": { "active":true,"round":1,"turn":0,"combatants":[ ... ] },
  "view": { "gm": {...}, "player": {...} }
}
```

Fog as a raster mask + `persist` is the DTT-quality approach (soft, pixel-precise, explored-
memory); vwag-table's current vector fog can remain a fallback `mode`.

## Migration path for vwag-table

Today vwag-table stores one monolithic state with base64 images and vector fog. The path:

1. **De-embed images** — store the map image as a file/blob referenced by id (the single
   biggest size + interop win), keeping the rest of the state as-is.
2. **Split authored vs. session** — pull the static map definition out of the live state into
   a module; keep tokens/fog/initiative/view as session state referencing it.
3. **Add the obstacle store** — the polyline+flags list, even before casting exists; a wall
   tool that just records geometry is useful and unblocks LoS/lighting later.
4. **Casting engine** — shadow/ray-cast against obstacles; LoS, lighting, and raster fog all
   ride on it (see `dtt-format-comparison.md`).
5. **VWAG generation + serving** — VWAG emits modules under `/maps/<id>/` and serves them;
   vwag-table fetches a module instead of loading a base64 blob; sessions persist to fallon.

Steps 1–2 are pure refactors of the save format and can happen independently of any lighting
work. Steps 3–4 are the occlusion engine. Step 5 is the VWAG integration.
