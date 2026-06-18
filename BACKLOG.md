# vwag-table backlog

Working tracker for vwag-table (the VWAG VTT, forked from Lodestar). Canonical idea
and design list; chunks are pulled from here.

## Done

- **Chunk 0** — fork stood up, `baseline-upstream` tag, fork README.
- **Chunk 1** — player display moves tokens by touch, synced to the GM; GM authoritative.
- **Chunk 2** — live drag streaming (grab / move / drop, frame-coalesced); authoritative
  snap on the GM; `touch-action: none` on `#battlemap` so a finger drag isn't hijacked as a
  scroll (also groundwork for multi-touch).
- **Token labels** — cap raised to 12 chars; auto-fit shrink so a name fits the token
  instead of being chopped; labels now render on image-art tokens too (light outline for
  legibility over art). Single shared `drawTokenLabel` helper.
- **Token type** — `player` / `npc` / `monster` field set at creation (Type select in the
  token tool), default monster. Color-coded ring just outside each token: player green,
  npc blue, monster red. Drawn on both the GM and player views. Rides along in save/load
  and player-sync for free; pre-existing tokens default to monster.

## Next — initiative <-> token linking

The initiative tracker and the board tokens are currently independent. Goal: the initiative
list auto-reflects the tokens on the board, categorized by type (player / npc / monster).

Design questions to settle before building (needs a read of the current initiative window):

- **Mirror vs snapshot** — does the list live-track the board (entries appear/leave as
  tokens are placed/removed), or is it populated on command?
- **Reconcile with manual entries** — the tracker already supports manual add/remove and
  ordering; does auto-population replace that or coexist with it?
- **Identity** — bind by token id; what does a row show (label, type, color)?
- **Turn pointer** — advancing the turn could highlight/center the active token on the board.
- **Edit type post-placement** — changing a placed token's type likely belongs in this UI.

## Feature backlog

- **Token library** — quick-add palette of saved presets (name, type, color, image, size);
  persist locally via IndexedDB, later via fallon.
- **Lighting system** — its own scoping pass. Forks between simple darkness/reveal layers
  (modest) and full line-of-sight + light sources + vision blocking (large, Foundry-like).
  Decide the flavor before any code.
- **GM-only type rings** (optional) — gate the type ring so players don't see token type by
  color. One-line view gate if wanted.

## Deferred — physical mini tracking (until the IR frame + TV table are built)

- The IR frame reports **every mini resting on the glass as a persistent contact point**
  (15 on the dev screen, 20 on the table frame); the engine tracks N simultaneous contacts.
- Movement is one mini per turn, so identity matching is **trivial**: the contact that moved
  is the active token; stationary contacts hold their bindings.
- Build order: multi-pointer engine (map keyed by `pointerId`) -> contact-to-token binding.
- Open questions: initial binding method (place-on-token vs pairing step), jitter dead-zone
  for resting minis, mixed physical/digital tokens, lift-and-replace rebinding.

## Notes

- Upstream: github.com/UnclePlants/Lodestar (MIT). Pull improvements via `git fetch upstream`.
- fallon (FastAPI + MySQL) integration is a later stage: persist map / token / fog /
  initiative state alongside campaign data.
