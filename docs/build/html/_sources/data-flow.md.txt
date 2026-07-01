# Data flow

Three flows carry the app: **load → render → broadcast**, the **map-import
pipeline**, and the **online relay**.

## Load → render → broadcast to the player display

The GM window is authoritative. It renders locally and broadcasts a sanitized
view to the player window over `BroadcastChannel` (and, when online, to the
relay).

```{mermaid}
graph LR
  file["save file / IndexedDB record"] --> persistence["persistence.js<br/>validate + migrate + hydrate"]
  persistence --> state["state.js<br/>live state"]
  state --> render["render.js<br/>draw GM canvas"]
  state --> sync["sync.js<br/>sanitize + broadcast"]
  sync --> channel["BroadcastChannel"]
  sync --> relay["online relay"]
  channel --> player["player window<br/>(same code, isPlayer)"]
  relay --> remote["remote players"]
```

## Map-import pipeline (DTT)

`dtt.js` reads a zipped map export, parses the `.dtt` JSON (six obstacle kinds
as open polylines in cell coords; light/token radii in feet), and installs it
into state. Distances are stored in feet, positions in cells — see
[Coordinate model](coordinate-model.md).

```{mermaid}
graph LR
  zip["map .zip"] --> readZip["dtt.readZip"]
  readZip --> parseDtt["dtt.parseDtt<br/>JSON -> obstacles / lights / grid"]
  parseDtt --> importDtt["dtt.importDtt"]
  importDtt --> rooms["rooms-obstacles.js<br/>wall segments"]
  importDtt --> vision["vision.js<br/>LOS input"]
  importDtt --> state["state.js"]
```

## Online relay

`api.js` owns auth and HTTP; `sync.js` owns the live relay connection. The GM
publishes; players redeem an invite and boot into a player view.

```{mermaid}
graph TD
  gm["GM window"] --> api["api.js<br/>auth + publish"]
  api --> backend["relay backend"]
  landing["landing.html<br/>redeem invite"] --> backend
  backend --> connectRelay["sync.connectRelay"]
  connectRelay --> playerview["player view boots<br/>from session token"]
```
