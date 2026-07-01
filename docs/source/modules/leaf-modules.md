# Leaf modules

Self-contained feature modules that own their own DOM/draw plus event wiring and
import only from `state.js` (and sometimes `geometry.js`). They never import
`main.js`; when they need an app-level action they call it through `hooks`. This
is the pattern that best demonstrates the codebase's modularity — each of these
could be lifted out or added with almost no blast radius.

## sandbox.js

Gates public-sandbox behavior via `isSandbox`. Self-wires on `DOMContentLoaded`.
Loaded directly by `index.html`.

## shortcuts.js

Keyboard shortcuts. Self-wires a `keydown` handler on `DOMContentLoaded`. Loaded
directly by `index.html`.

## pdf-windows.js

Floating, draggable, resizable PDF viewer windows (open/close/swap/drag/resize,
z-order bump on click). Self-wires. Loaded directly by `index.html`.

## image-handles.js

Resize/rotate handles for a placed map image. Exports `syncImageHandles` (called
by `render.js`), self-wires its own pointer move/up handlers, and commits the
resized/rotated image to players via `hooks.renderAndSync`. Imports `state` and
`geometry` only.

## token-arrows.js

Octant step arrows drawn around a selected token: `drawTokenStepArrows`,
`hitTokenStepArrow`, `arrowAnchorToken`. Imports `state` and `geometry` only;
`main.js` and `render.js` call its draw/hit functions.

## notes-panel.js

The notes drawer — a slide-out searchable list plus a rich-text body:
`initNotesPanel`, `refreshNotesPanel`. Reads `controls.notes*`, and calls up
through `hooks.render`, `hooks.pushHistory`, and `hooks.syncPanels`. Imports
`state` only.
