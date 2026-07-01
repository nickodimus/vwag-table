# Module reference

One-line ownership plus public exports for the remaining modules. The
architecturally load-bearing modules have their own pages
([state](state.md), [render](render.md), [main](main.md), [vision](vision.md))
and the leaf modules are covered in [Leaf modules](leaf-modules.md).

## geometry.js
Pure coordinate/geometry math; imports only `state`. See
[Coordinate model](../coordinate-model.md).
**Exports:** `simplifyPolyline`, `distToSegment`, `pointInPolygon`,
`gridCellNative`, `pxPerCellNative`, `nativeToCells`, `cellsToNative`,
`tokenRadius`, `snapToGrid`, `snapNative`, `worldDims`, `activeView`,
`fitScaleFor`, `viewTransform`, `clientToCanvasPoint`, `currentViewRotation`,
`keepUpright`, `screenToNative`, `nativeToScreen`, `followView`, `cellWorldPx`,
`FOLLOW_FIT_PADDING`, `FOLLOW_FIT_MIN_CELLS`.

## db.js
IndexedDB wrapper; imports only `state`.
**Exports:** `openMapDatabase`, `withStore`, map/module/session/token record CRUD
(`saveMapRecord`, `listMapRecords`, `deleteMapRecord`, `saveModuleRecord`, …),
and image helpers (`putImage`, `getImageRecord`, `getImage`).

## content.js
Remote content resolution + navigation trail + cache; imports `db`.
**Exports:** `registerRemoteSource`, `resolveSession`, `resolveModule`,
`resolveImage`, `trailActiveId`, `trailDepth`, `trailList`, `trailPush`,
`trailPop`, `trailReset`, `cacheHas`, `cacheGet`, `cacheSet`, `cacheClear`.

## persistence.js
Save-file schema + migration; imports `db`, `state`.
**Exports:** `validateSessionData`, `migrateState`, `hydrateFloorImages`,
`mergeModuleSession`, `migrateMapsToModulesAndSessions`, `captureCurrentFloor`,
`splitState`, `makeMapId`, `deriveCellGrid`, `snapshotFromLiveState`.

## api.js
Online-tier HTTP client + auth; imports `content`.
**Exports:** `getToken`, `getUsername`, `isLoggedIn`, `isAdmin`, `logout`,
`authHeader`, `adoptStoredGuest`, `login`, `register`, `refreshWhoami`,
`apiFetch`, `listRemoteModules`, `publishModule`, `putRemoteImage`,
`publishSession`, `remoteModuleExists`, `fetchRemoteSession`,
`deleteRemoteModule`.

## sync.js
GM→player broadcast + online relay; imports `state`, `persistence`, `api`.
GM-authoritative.
**Exports:** `relay`, `applyRemoteView`, `applyIncomingPlayerView`,
`syncPlayerViewControls`, `snapPlayerViewToGM`, `broadcastAssets`,
`broadcastState`, `broadcastView`, `renderAndSync`, `renderAndSyncView`,
`sanitizedState`, `connectRelay`, `refitFramedView`.

## fog.js
Fog-of-war layer; imports `state`.
**Exports:** `resizeFogLayer`, `buildStrokeLayer`, `rebuildFog`, `compositeFog`,
`roomPathFog`, `strokePathFog`, `polygonCentroid`, `drawStampDraft`,
`drawPolygon`, `stampPolygon`, `addInterpolatedStrokePoints`.

## tokens.js
Token drawing; imports `state`, `geometry`, `annotations`, `initiative`,
`vision`.
**Exports:** `tokenIsSquare`, `tokenOutline`, `drawTokenTypeRing`,
`drawActiveTurnRing`, `drawTokens`.

## aoe-measure.js
AoE templates + measurement/calibration; imports `state`, `geometry`.
**Exports:** `drawAoeTemplate`, `drawAoes`, `drawAoeLabels`, `hitAoe`,
`drawMeasureLine`, `drawMeasureLabel`, `drawCalibrationDraft`, `measureCellWorld`,
`updateCalibrationUI`, `updateMeasureCalibrateRow`.

## annotations.js
Note pins, map images, pings; imports `state`, `geometry`.
**Exports:** `wrapNoteText`, `noteFont`, `noteLayout`, `noteScreenRect`,
`drawNotes`, `hitNote`, `drawImages`, `hitImage`, `snapImage`, `getTokenImage`,
`addPing`, `ensurePingLoop`, `drawPings`.

## initiative.js
Initiative order + HP; imports `state`.
**Exports:** `sortedCombatants`, `activeTurnTokenId`, `tokenHp`,
`clampInitiativeTurn`, `renderInitiativePanel`, `renderInitiativeOverlay`,
`updateInitiativeUI`.

## rooms-obstacles.js
Room & obstacle geometry; imports `state`, `geometry`, `vision`, `fog`. Produces
the wall segments (`moveSegments`) that vision consumes.
**Exports:** `drawRoomOutlines`, `drawObstacleOutlines`, `drawDraftObstacle`,
`wrapLabel`, `drawRoomNames`, `drawDraftRoom`, `obstacleDefaults`, `hitObstacle`,
`moveSegments`.

## view.js
Camera loop; imports `state`, `geometry`.
**Exports:** `tickCamera`, `ensureCameraLoop`, `stopCameraLoop`, `rotateMap`.

## dtt.js
DTT module reader + normalizer; imports `map-import`. Reads a zipped DungeonDraft
`.dtt` export in-browser (hand-rolled unzip), then normalizes it (feet → cells)
into the shared content shape and installs it. See [Data flow](../data-flow.md).
**Exports:** `readZip`, `parseDtt`, `importDtt`.

## parse-uvtt.js
Universal VTT parser; imports `map-import`. Turns a `.uvtt` / `.dd2vtt` /
`.df2vtt` JSON (origin offset applied, grid-square units, `AARRGGBB` colors,
embedded base64 image) into the shared content shape and installs it.
**Exports:** `parseUvtt`, `importUvtt`.

## map-import.js
The shared, format-agnostic map installer; imports `state`, `geometry`,
`vision`, `rooms-obstacles`. Bakes a normalized content object (obstacles /
lights / tokens / notes, in cells) to native px and writes the stores. Every
import format normalizes to this one seam. See [Data flow](../data-flow.md).
**Exports:** `installParsedMap`.
