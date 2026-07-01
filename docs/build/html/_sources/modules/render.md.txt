# render.js

The draw-side aggregator. Where `main.js` orchestrates *actions*, `render.js`
composes the *frame*: it imports the draw functions of nearly every visual
module and paints them onto the canvas layers in order. It is imported by
`main.js` but never imports it back — the two aggregators meet only through
`state.js`.

## Imports (draws from)

`vision`, `tokens`, `fog`, `annotations`, `rooms-obstacles`, `aoe-measure`,
`image-handles`, `token-arrows`, plus `geometry` and `state`.

## Public exports

`render` (the master draw), `drawGrid`, `drawToolPreview`, `drawToolShapePath`,
`renderSplash`, `drawCastDebug`, `drawPlayerFrame`, `drawPlayerMarquee`,
`drawStairs`, `playerFrameCorners`.

## Render / sync split

`render.js` draws the **local GM canvas** only. Broadcasting the view to the
player window and the online relay is `sync.js`'s job. Movement is
GM-authoritative: the GM renders, then `sync.js` sanitizes and pushes. See
[Data flow](../data-flow.md).
