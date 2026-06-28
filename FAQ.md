# vwag-table — FAQ

## General

**What is vwag-table?**
A local-first virtual tabletop for game masters. The GM runs a private panel and casts a battlemap — with fog of war, dynamic light, and line-of-sight — to a second screen for the players. It runs in the browser with no build step, no dependencies, and no account.

**Do I need an account or an internet connection?**
No, not for normal play. The GM and player windows talk to each other directly in the browser, fully offline. You only need a backend (and an account, or your own server) if you want *online* play with players who aren't in the room — see *Online play* below.

**Is this related to Lodestar?**
Yes — vwag-table started as a fork of [Lodestar](https://github.com/UnclePlants/Lodestar) and has since diverged into its own program. It's MIT-licensed, original authorship is credited, and upstream improvements are ported by hand with the author's blessing.

## Setup and use

**How do I start a game?**
Serve the folder over HTTP (`python3 -m http.server 8000`), open `http://localhost:8000` for the GM view, load a map image, then click **Open player display** and move that window to your second screen or touch table.

**Do I need the infrared touch table?**
No. The IR touch frame is an optional setup vwag-table is *designed* to support, but it works with any display and a mouse. Touch is just another input.

**Can I use my own maps?**
Yes — load any image as a map. If you plan to share screenshots or the project publicly, prefer maps under a Creative Commons license (e.g. CC BY) and attribute the creator.

**Can I import token art in bulk?**
Yes. Select multiple image files at once and each becomes a reusable token in your palette, named from its filename and downscaled automatically. Drop them onto the map from the palette as needed.

**How do players move their own token?**
On the player display, a player drags their token; the move is sent to the GM, who clamps it to the rules and rebroadcasts it so every screen stays in sync. The GM stays authoritative.

**Can players see my notes or the unrevealed map?**
No. GM-only notes, controls, and any area still under fog never appear on the player display.

## Saving and backups

**Where are my maps saved?**
In your browser's own local storage (IndexedDB) on your machine. Nothing is uploaded for local play.

**Why don't my saved maps show up on another computer or browser?**
The library is tied to a specific browser, device, and site address. To move maps, use **Export** to write the whole library to a single JSON file, then **Import** it wherever you need it. That exported file is the only copy that isn't tied to one browser.

## Online play

**How does online play work?**
Online play lets remote players watch the table and move their tokens over the internet. It needs a relay backend, which is **not** part of this repo. Once a backend is connected, the GM mints a join code, the player redeems it on a landing page, and each device fits the GM's broadcast region to its own screen.

**Can I run online play without the VWAG backend?**
Yes. You can run your own WebSocket relay that implements the join/redeem and sync protocol. Alternatively, connect to the VWAG backend by creating an account and logging in — VWAG is the maintainer's own hosted instance, separate from this open-source client.

**Does it work on a phone or tablet?**
The player view does — a phone, tablet, or laptop each fits the cast region to its own screen. The GM panel is best driven from a larger screen.

## Technical

**Which browsers are supported?**
Current Chromium-based browsers (Chrome, Edge). vwag-table needs `BroadcastChannel`, `IndexedDB`, `ResizeObserver`, and Canvas 2D, all standard in modern browsers.

**Is there a build step or any dependencies?**
No. It's vanilla ES modules — serve the folder and open it. Nothing to compile or install.
