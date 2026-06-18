# vwag-table map-module framework (proposed)

A target format for vwag-table maps, modeled on Digital Tabletops (DTT), fitted to
vwag-table + VWAG `/maps/` serving. vwag-table is intended to **supersede DTT**, so DTT
matters here in two ways only: (1) as a feature-parity reference, and (2) as a **one-way
import source** (load a DTT `.zip` into vwag-table). No DTT export. Design spec, future work.
Grounded in two DTT exports (Caves of Chaos, Temple of Sages), the running DTT GM/player
screens, the settings panel, and the map editor.

## Core principle: authored module vs. session state

The split the current vwag-table save gets wrong by mashing everything into one blob:

- **Authored module** — static, VWAG-generated: map image, grid, coordinate space, obstacle
  geometry, lights, room labels, spawns, VWAG linkage. Versioned, shareable, replayable;
  lives under VWAG `/maps/`.
- **Session state** — per-play, persisted separately (disk or fallon): fog progress, token
  instances + positions + HP/conditions, initiative, view framing, open doors, current
  time-of-day. References a module by id.

vwag-table's native format is free to be whatever serves vwag-table best (it never has to
round-trip back to DTT); DTT is only read on import.

## Coordinate space

Cell units, not pixels (DTT's model; the editor sets Map Size directly in cells, e.g.
128 × 90). Module declares grid in cells + pixels-per-cell; geometry, lights, spawns, token
sizes, vision/light radii, speeds are all in cells. (Caves of Chaos 128×90 @ 100 px/cell;
Temple of Sages 34×44 @ 72 px/cell — px/cell is per-map, which is why cells beat pixels.)

```json
"grid": { "cellsX":128, "cellsY":90, "pxPerCell":100, "color":"#ffffff", "alpha":0.25,
          "type":"square", "display":"both" }
```

## Obstacle geometry — unified, six kinds

DTT's editor exposes exactly six kinds (confirmed in the Walls dropdown): **Wall, Object,
Door, Window, Ethereal, Invisible**. Model them as one obstacle list of polylines with a
`kind` tag + behavior flags (one list feeds one casting routine; the tag drives the draw tool
and the DTT import):

```json
"obstacles": [
  { "id":"w12","kind":"wall","points":[[6.5,32.3],[1.5,32.4],[1.6,30.3]],
    "blocksSight":true,"blocksLight":true,"blocksMove":true,"drawn":true,
    "openable":false,"defaultOpen":false }
]
```

Behavior by kind (all overridable):

| kind | sight | light | move | drawn | notes |
|---|---|---|---|---|---|
| wall | block | block | block | yes | polyline |
| object | block | block | block | yes | closed polygon (props/furniture) |
| door | toggle | toggle | toggle | yes | openable; session tracks open by id |
| window | pass | pass | block | yes | see-through, not walkable |
| invisible | block | block | block | **no** | LoS wall with no drawn line |
| ethereal | (reserved) | (reserved) | block? | ? | low priority — see note; default-map on import |

## Lights (authored) + ambient

```json
"ambient": { "timeOfDay":0.0 },   // 0-24h; 0 = night (dark), 12 = noon
"lights": [ { "id":"L1","position":[123.7,17.1],"radius":7.0,"color":"#ffd9a0","active":true } ]
```

Per-token light/vision lives on the token instance (session): bright/dim radius, torch.

## Rendering model (from the running screens)

Same scene, two views. Pipeline:

1. Draw the map image.
2. Apply **ambient darkness** from `timeOfDay`.
3. For each active light + each token's bright/dim radius, **cast against obstacles** to a lit
   polygon; composite onto the darkness. "Soft Light" = soft falloff at the dim edge.
4. Apply **line-of-sight**: cast from the viewer's tokens (player) or all (GM); hide occluded.
5. Apply **fog**: explored (when `persist`) shown dimmed by a brightness control; unexplored
   hidden. "Reset Fog" clears it; "Manual Fog" paints it by hand.

**GM view:** whole map, unexplored dimmed (Fog Brightness), obstacle geometry overlaid as
editable yellow polylines ("Walls Visible to DM"), plus the player-view frame.
**Player view:** only lit AND in-LoS AND explored — at night, a soft bubble around the party
with an enemy barely visible at its edge. This is vwag-table's `isPlayer` split.

## GM options to reach parity (supersede DTT)

From the settings panel and editor, the option/feature set to match or improve on:

- **Fog:** Fog Brightness slider, Persistence (explored memory), Reset Fog, Manual Fog (paint).
- **Lighting:** Soft Light, Torch Follows DM Movement (a light tracking the DM cursor/view),
  per-token torch + bright/dim radius, placed lights, ambient time-of-day.
- **Line of Sight:** on/off; Walls Visible to DM (geometry overlay).
- **Movement:** Snap Movement to Grid; Lock Movement to Active Token During Combat (only the
  active-turn token moves) — pairs with the initiative turn link vwag-table already has.
- **Player screen:** Show Initiative on Player Screen, Show Counters on Player Screen.
- **Grid:** Grid Type display (lines / both) and shape (square / hex).
- **Editor (Draw Mode):** pick a kind (Wall/Object/Door/Window/Ethereal/Invisible) and draw
  polylines; set Map Size in cells, rotation, grid color, map name; Save and Exit.
- **Library:** import / edit / delete / tokens / assets — vwag-table already has a library;
  add an "Import DTT zip" entry (below).

## DTT import (one-way)

Read DTT's five files and convert into a vwag-table module + initial session:

| DTT | vwag-table | Notes |
|---|---|---|
| `map.webp` | module map image | store as file/blob by id |
| `thumb.webp` | module thumb | use directly |
| `data.dtt` walls/doors/windows/objects/invisibles/ethereals | `obstacles[]` | bucket -> kind + flags |
| `save.json` `lights` | `lights[]` | 1:1 (default a light color) |
| `save.json` `time_of_day` | `ambient.timeOfDay` | 1:1 |
| `save.json` `line_of_sight` | `lineOfSight` | 1:1 |
| `save.json` `grid_color`/`grid_on` | `grid` | + cell size from `data.dtt size` |
| `fog.webp` + `persist` | session `fog.mask` + `persist` | raster import |
| `save.json` `opened[{bounds}]` | session `openDoors[]` | match door by geometry |
| `save.json` `tokens[]` | session `tokens[]` | position/size/type/color(border)/image(path)/hp/init/speed/vision |
| `save.json` `notes[]` | module `pins[]` | position + text |
| `save.json` `starting_pos` | module start / player view | 1:1 |

No reverse direction. vwag-only concepts (floors, stairs, named fog rooms, splash, measure)
just don't exist on a freshly imported DTT map; you add them in vwag-table afterward.

Note on **ethereal**: a Caves of Chaos export taken *after* adding an ethereal section still
had an empty `ethereals` array (byte-identical to the original). So DTT likely does not
serialize ethereals to the export (or they must be committed via Save and Exit first). For
the one-way import this means ethereal geometry will rarely or never arrive — treat the kind
as low priority and default-map it (to a wall, or a move-only barrier) rather than blocking
on its exact semantics. Revisit only if a confirmed-saved export ever contains one.

## VWAG linkage (long-game seam)

```json
"vwag": { "moduleId":"ea31-...", "ea":31,
  "spawns":[ { "position":[0.0,17.5], "creatureRef":"vwag:creature/..." } ] }
```

A spawn/token resolves to a real VWAG creature record (HP, speed, vision) — the stat-import
target; the `tokenId` link vwag-table already has is the runtime half.

## Migration path

1. **De-embed images** — store the map image as a file referenced by id. Pure refactor.
2. **Split authored vs. session** — pull the static map out of live state into a module;
   tokens/fog/initiative/view become session state referencing it. Pure refactor.
3. **Cell coordinates** — adopt cells (or a px<->cell conversion).
4. **Obstacle store + Draw Mode** — the polyline+flags list with the six kinds and a draw tool.
5. **Casting engine** — shadow/ray-cast against obstacles; LoS, lighting, raster fog ride on
   it; render per the GM/player pipeline. Add the GM options above.
6. **DTT import adapter** — read a DTT zip into a module + session, per the table. One-way.
7. **VWAG generation + serving** — VWAG emits/serves modules under `/maps/<id>/`; vwag-table
   fetches a module; sessions persist to fallon.

Steps 1–3 are independent save-format refactors with immediate payoff. Steps 4–5 are the
occlusion/lighting engine (the bulk of the parity work). Step 6 is the DTT import. Step 7 is
VWAG integration. DTT import (6) only needs the obstacle store + a raster-fog layer in place,
so it can land as soon as 4 (and a fog raster) exist — you can migrate your DTT library in
before the full lighting engine is finished.
