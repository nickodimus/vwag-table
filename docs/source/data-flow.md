# Data flow

Three flows carry the app: **load → render → broadcast**, the **map-import
pipeline** (DTT + Universal VTT), and the **online relay**.

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

## Map-import pipeline (DTT + Universal VTT)

Two import formats share one installer. `main.js` sniffs the file (a `PK` zip is
a DTT module; anything else is Universal VTT JSON) and drives the matching
parser. Each parser normalizes its format into the **same content shape** — a
plain object of obstacles / lights / tokens / notes in cell coordinates — and
hands it to `map-import.installParsedMap`, which bakes cells → native px and
writes state. Format-specific unit quirks (DTT distances in feet, UVTT ranges in
grid squares; see [Coordinate model](coordinate-model.md)) are resolved inside
each parser, so the installer is format-agnostic. Adding a format is "write a
parser that emits the content shape," never "touch the installer."

```{mermaid}
graph LR
  zip["map .zip (DTT)"] --> readZip["dtt.readZip"]
  readZip --> parseDtt["dtt.parseDtt"]
  parseDtt --> normDtt["dtt.normalizeDtt<br/>feet -> cells"]
  uvtt["Universal VTT<br/>.uvtt / .dd2vtt / .df2vtt"] --> parseUvtt["parseUvtt<br/>origin + units + colors"]
  normDtt --> content["shared content<br/>obstacles / lights /<br/>tokens / notes (cells)"]
  parseUvtt --> content
  content --> install["map-import.installParsedMap<br/>bake cells -> native, write stores"]
  install --> state["state.js"]
  state --> consumers["vision.js + rooms-obstacles.js<br/>consume state.obstacles"]
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
