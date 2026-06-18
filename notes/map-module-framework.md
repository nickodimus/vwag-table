# vwag-table map-module framework (proposed)

A target format for vwag-table maps, modeled on Digital Tabletops (DTT), fitted to
vwag-table + VWAG `/maps/` serving, AND **bidirectionally interoperable with DTT zips**
(pull a DTT backup into vwag-table and export a vwag-table map back out as a DTT zip).
Design spec, future work. Grounded in two DTT exports (Caves of Chaos, Temple of Sages),
the running DTT GM/player screens, and the current vwag-table save.

## Core principle: authored module vs. session state

The split the current vwag-table save gets wrong by mashing everything into one blob:

- **Authored module** — static, VWAG-generated: map image, grid, coordinate space, occlusion
  geometry, lights, room labels, spawns, VWAG linkage. Versioned, shareable, replayable;
  lives under VWAG `/maps/`.
- **Session state** — per-play, persisted separately (disk or fallon): fog progress, token
  instances + positions + HP/conditions, initiative, view framing, open doors, current
  time-of-day. References a module by id.

## DTT interoperability is a hard requirement (bidirectional zip)

End state: import a DTT `.zip` into vwag-table and export a vwag-table map as a DTT `.zip`.
Design rule that follows: **vwag-table's native model aligns 1:1 with DTT on every shared
concept** (cell coordinates, obstacle geometry, lights, ambient, raster fog + persist), so
the adapter is nearly a rename. vwag-table's extras (floors, stairs, named fog rooms, splash,
measure units) layer on top and are dropped on DTT export / absent on DTT import.

DTT package = five files: `map.webp`, `fog.webp` (raster fog), `thumb.webp`, `save.json`
(state + lights + tokens + flags), `data.dtt` (geometry: walls/doors/windows/objects/...).
vwag-table must read and write exactly these.

## Coordinate space

Cell units, not pixels (DTT's model). Module declares grid in cells + pixels-per-cell;
geometry, lights, spawns, token sizes, vision/light radii, speeds are all in cells.

```json
"grid": { "cellsX": 128, "cellsY": 90, "pxPerCell": 100, "color": "#ffffff", "alpha": 0.25 }
```

(Caves of Chaos 128x90 @ 100 px/cell; Temple of Sages 34x44 @ 72 px/cell — px/cell is
per-map, which is why cells beat pixels for portability.)

## Occlusion geometry — unified

DTT uses fixed buckets; across samples shapes vary (walls are 2-pt segments OR multi-point
polylines; objects are closed polygons; windows/doors are segments). Use **one obstacle list
of polylines with behavior flags** + a `kind` tag for tooling and DTT round-trip:

```json
"obstacles": [
  { "id":"w12","kind":"wall","points":[[6.5,32.3],[1.5,32.4],[1.6,30.3]],
    "blocksSight":true,"blocksLight":true,"blocksMove":true,
    "openable":false,"defaultOpen":false }
]
```

Defaults by kind (overridable): **wall** blocks sight/light/move; **door** openable (closed
blocks all, open passes all); **window** blocks move, passes sight + light; **object** closed
polygon, blocks sight + move; **custom** explicit flags (covers DTT `invisibles` = block +
undrawn, `ethereals` = reserved).

## Lights (authored) + ambient

```json
"ambient": { "timeOfDay": 0.0 },   // 0-24 hours; 0 = night (dark), 12 = noon
"lights": [ { "id":"L1","position":[123.7,17.1],"radius":7.0,"color":"#ffd9a0","active":true } ]
```

Per-token light/vision lives on the token instance (session): bright/dim radius, torch.

## Rendering model (from the running DTT screens)

Same scene renders two ways. Pipeline, per view:

1. Draw the map image.
2. Apply **ambient darkness** from `timeOfDay` (Caves of Chaos at 0 = near-black).
3. For each active light + each token's bright/dim radius, **cast against obstacles** to get
   a lit polygon; composite light onto the darkness (reveal + falloff at dim edge).
4. Apply **line-of-sight**: cast from the viewer's tokens (player) or treat all as visible
   (GM); hide what's occluded.
5. Apply **fog**: explored areas (when `persist`) shown dimmed; unexplored hidden. A
   brightness control sets the dim level.

**GM view:** whole map visible, unexplored *dimmed* (Fog Brightness slider, not binary), the
obstacle geometry drawn as an overlay (DTT draws it as yellow polylines) for editing, plus
the player-view frame (DTT's green rectangle = vwag-table's `playerView`).

**Player view:** only what is lit AND in line-of-sight AND explored. At night that's a soft
glowing bubble around the party's light, an enemy token barely visible at the light's edge,
everything else black. This is the `isPlayer` split vwag-table already renders through.

## UI controls (observed in DTT, mapped to vwag-table)

Grid Visible, Initiative, **Fog Brightness** (slider -> fog dim level on GM), **Persistence**
(`persist`), **Line of Sight** (toggle), **Reset Fog**, **Manual Fog** (paint by hand),
**Draw Mode** (draw obstacle geometry), Load Map, Remote Play. Most already exist in
vwag-table or map onto planned controls; Fog Brightness, Persistence, LoS, and Draw Mode are
the new ones tied to the occlusion engine.

## Session state (separate document)

```json
{
  "moduleId":"caves-of-chaos",
  "fog":{ "mode":"raster","persist":false,"mask":"session-fog.webp","brightness":0.3 },
  "openDoors":["d3"],
  "timeOfDay":0.0,
  "tokens":[ { "id":"t1","instanceOf":"vwag:creature/...","position":[127.5,49.5],
    "hp":20,"type":"player","label":"Player 1","color":"#d6a94d",
    "brightRadius":5,"dimRadius":10,"torchOn":true,"visibility":true } ],
  "initiative":{ "active":true,"round":1,"turn":0,"combatants":[ ... ] },
  "view":{ "gm":{...},"player":{...} }
}
```

Fog as a raster mask + `persist` is DTT's approach and the one to match; vwag-table's vector
fog can remain a fallback `mode` (rasterized on DTT export).

## DTT <-> vwag-table field mapping

| Concept | vwag-table | DTT | Notes |
|---|---|---|---|
| Map image | `imageData` (base64) | `map.webp` | de-embed to a file |
| Thumb | (none) | `thumb.webp` | generate on export |
| Coords | pixels | cells | convert px<->cell |
| Grid | `grid{size,color,opacity}` | `grid_color`,`grid_on` | cell size from map size |
| Obstacles | `obstacles[]` (kind+flags) | `walls/doors/windows/objects/invisibles/ethereals` | kind<->bucket |
| Open doors | `openDoors[id]` | `opened[{bounds}]` | match by geometry (DTT uses bounds string) |
| Lights | `lights[]` | `lights[]` | near 1:1; DTT lacks per-light color -> drop on export |
| Ambient | `timeOfDay` | `time_of_day` | 1:1 |
| LoS toggle | `lineOfSight` | `line_of_sight` | 1:1 |
| Fog | raster mask + `persist` | `fog.webp` + `persist` | 1:1 raster; rasterize vector fog on export |
| Token | `{id,x,y,cells,color,label,type,image}` + session HP/light | `{position,size,type,border_color,path,health,init,speed,bright/dim_radius,torch_on,visibility}` | color<->border_color; image base64<->path; label has no DTT home |
| Initiative | separate `initiative` block, linked by `tokenId` | `init` baked on token | reconcile on round-trip |
| Notes/pins | sticky notes / named fog rooms | `notes[{position,text}]` | room labels round-trip; sticky notes are vwag-only |
| Start pos | (player view / spawn) | `starting_pos` | 1:1 |
| Floors | `floors[]` (multi-level) | (none) | **lossy** — export current floor, or one zip per floor |
| Stairs | `stairs[]` | (none) | **lossy** — vwag-only |

## VWAG linkage (long-game seam)

```json
"vwag": { "moduleId":"ea31-...", "ea":31,
  "spawns":[ { "position":[0.0,17.5], "creatureRef":"vwag:creature/..." } ] }
```

A spawn/token resolves to a real VWAG creature record (HP, speed, vision) — the stat-import
target; the `tokenId` link vwag-table already has is the runtime half.

## Migration path

1. **De-embed images** — store the map image as a file referenced by id (biggest size +
   interop win). Pure save-format refactor.
2. **Split authored vs. session** — pull the static map out of live state into a module;
   tokens/fog/initiative/view become session state referencing it. Pure refactor.
3. **Cell coordinates** — adopt cells (or a px<->cell conversion) so geometry/light/vision
   travel and match DTT.
4. **Obstacle store** — the polyline+flags list + a Draw Mode tool; useful before casting.
5. **Casting engine** — shadow/ray-cast against obstacles; LoS, lighting, raster fog ride on
   it. Render per the GM/player pipeline above.
6. **DTT adapter** — import DTT zip -> module + session; export module + session -> DTT zip,
   per the mapping table. Bidirectional backup compatibility.
7. **VWAG generation + serving** — VWAG emits/serves modules under `/maps/<id>/`; vwag-table
   fetches a module; sessions persist to fallon.

Steps 1–3 are independent save-format refactors with immediate payoff (smaller saves, the
serving seam) and need none of the lighting work. Steps 4–5 are the occlusion engine. Step 6
is DTT interop. Step 7 is VWAG integration.
