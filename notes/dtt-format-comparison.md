# Map format comparison — vwag-table vs. Digital Tabletops

Reference for the future occlusion/lighting work. Compares the current vwag-table map save
against a Digital Tabletops (DTT) export (`Caves Of Chaos`), and frames what it would take
for vwag-table to reach DTT-level fog / line-of-sight / lighting. Not a commitment — a map.

## 1. Packaging

**vwag-table** — one self-contained JSON (a library of maps). Images (map, floors, tokens)
are embedded as base64 data URLs. The sample file is ~11.5 MB, of which the scene state is a
few KB and the rest is image data.

**DTT** — a folder/zip per map:

- `map.webp` — the map image, as an image (12800x9000).
- `fog.webp` — fog stored as its own raster (6400x4500 RGBA, half map-res).
- `thumb.webp` — 512x360 thumbnail.
- `save.json` — runtime/scene state (~16 KB).
- `data.dtt` — occlusion geometry (~115 KB, JSON despite the extension).

Takeaway: DTT keeps pixels as files and state as small JSON. For vwag-table, separating
images (store once, reference by id) is the move if saves get large or we want interop — and
it is also how fallon persistence and "maps as modules" would naturally work.

## 2. Coordinate system

**vwag-table** — pixel coordinates in map-image space (e.g. token at x=6830, y=4346 on a
12800x9000 map). Grid size in pixels.

**DTT** — grid-cell units. Map `size` is `{x: 128, y: 90}` cells; the image is 100 px/cell.
Tokens, walls, lights, and notes all live in the 0–128 / 0–90 cell space.

Cell units make distances, vision radii, light radii, and movement speeds resolution-
independent and game-native. Any vision/lighting work in vwag-table will want cell units (or
a clean px<->cell conversion).

## 3. Fog of war

**vwag-table** — vector fog: `fog.rooms` (polygons) + `fog.strokes` (brush/bucket), with
`gmColor` / `gmOpacity`. No raster, no explored-memory concept beyond the saved vectors.

**DTT** — raster fog: `fog.webp`, an RGBA alpha mask painted as areas are explored. The
`persist` flag in `save.json` controls explored-memory: whether revealed areas stay revealed
or re-hide when out of sight. The mask saves with the package and restores exactly.

Why DTT's fog looks better: a painted alpha mask gives soft, pixel-precise reveal that vector
polygons can't match, and persistence gives the "we've been here" memory effect.

## 4. Line of sight

**vwag-table** — none.

**DTT** — `data.dtt` is pure occlusion geometry, all as line segments `[[x1,y1],[x2,y2]]`
in cell units:

- `walls` — 112 segments (block sight + movement).
- `doors` — 47 segments; the `opened` list in `save.json` tracks which are currently open
  (an open door stops blocking).
- `windows` — see-through-not-walkable (empty in this map).
- `ethereals`, `invisibles`, `objects` — other geometry categories (empty here).

`line_of_sight: true` turns dynamic LoS on. Token vision is cast against these segments to
decide what each token can see.

## 5. Lighting

**vwag-table** — none.

**DTT** — three layers:

- `time_of_day` — global ambient (day/night).
- `lights` — 87 placed point lights, each `{active, position, radius}`.
- per-token light baked on the token: `bright_radius`, `dim_radius`, `torch_on`.

All of it is occluded by the same wall geometry from `data.dtt`.

## 6. Tokens

**vwag-table token** — `{id, x, y, cells, color, label, type, image(base64)}`.

**DTT token** — `{position, size, type, border_color, image(path), health, init, speed,
bright_radius, dim_radius, torch_on, visibility}`.

DTT bakes initiative, HP, movement, and vision/light onto the token itself — the token *is*
the creature. That is the "tokens are combatants" model and the exact seam our VWAG stat-
import aims at: a token resolving to a real creature record with stats. Their image is a file
path, not embedded.

## 7. Shared concepts

Grid (color/on), tokens (position/type/size/image), notes (DTT: simple map pins
`{position, text}` — 82 labeled rooms like "ENTRANCE J"), a starting position, and initiative
(DTT on the token; vwag-table in a separate `initiative` block with linked combatants).

## 8. The architectural insight (occlusion-geometry-first)

DTT's fog, line-of-sight, and lighting are **not three features — they are three views on one
engine**: vector occlusion geometry plus a casting routine. vwag-table is missing exactly two
foundations:

1. **Vector occlusion geometry** — walls/doors as line segments (a wall-drawing tool that
   stores `[[x1,y1],[x2,y2]]`, doors as toggleable segments).
2. **A casting routine** — shadow/ray-casting from a point (token or light) against those
   segments to produce a visible/lit polygon.

Once those exist:

- **Line of sight** = cast from each token's position; hide what's occluded.
- **Lighting** = cast from each light + token light radius; composite a light/shadow layer;
  modulate by `time_of_day`.
- **High-quality fog** = a raster alpha layer (offscreen canvas mask) revealed by the cast
  visible polygons, with a `persist` flag for explored-memory.

So the backlogged "lighting system" is really: **build the segment store + the casting engine
first; LoS, lighting, and good fog then fall out of it.** That is the "simple vs. full" fork
flagged earlier, now with DTT as a concrete reference to model against.

## 9. Forward (future work, not now)

- **Maps as modules from VWAG.** Adopt a DTT-style package per map (image + small JSON state
  + geometry + fog raster), served from VWAG `/maps/` so vwag-table loads a module rather than
  a monolithic base64 blob. Smaller saves, real interop, fallon-friendly.
- **VWAG stat import.** Tokens carry the `tokenId` link today; a module map can resolve a
  token to a real VWAG creature record (HP, speed, vision) — DTT's per-token model is the
  template.
- **Cell-based coordinates.** Move vwag-table toward cell units (or a clean conversion) to
  make vision/light/speed/distance natural.
