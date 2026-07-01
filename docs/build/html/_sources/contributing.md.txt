# Contributing

## Ground rules

- **Complete files only** — never patches, diffs, or inline snippets. Deliver
  whole files.
- **Source-first** — read the actual code before any claim about a module,
  export, or data flow.
- **No dependencies added to the app.** The runtime has none and stays that way.
  Sphinx's Python deps live in `docs/requirements.txt`, isolated from the app.
- **Lockstep** — when a module changes materially, update its docs page
  (`docs/source/modules/…`) in the same chunk. Same rule the README follows for
  user-facing features.

## ES-module syntax check

Plain `node --check file.js` fails on ES modules. Use:

```bash
cp file.js /tmp/c.mjs && node --check /tmp/c.mjs
```

This is syntax-only — the real validator is a cross-window browser test.

## Git flow (one chunk = one branch = one issue)

```bash
git fetch && git reset --hard origin/main
git checkout -b chunk-<slug>
# apply complete files, verify
git add <files>
git commit -m "<message>"
git checkout main && git merge --no-ff chunk-<slug>
git push
```

The public repo auto-deploys to fallon within ~5 min via a cron `git pull`.

## Building the docs

The docs have their own isolated toolchain and never touch the app runtime.

```bash
cd docs
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
sphinx-build -b html source build/html
```

Open `docs/build/html/index.html`. Since the HTML is committed, the built docs
are readable straight from a clone (open the file) and can be served at a URL
(GitHub Pages, or a subpath on fallon's Apache). Note: GitHub's file browser
shows committed HTML as *source*, not rendered — use Pages or open locally to
read it rendered.

## Mermaid discipline

Diagrams are validated at build time (a bad diagram fails the build). Rules
learned the hard way:

- Quote subgraph titles: `subgraph "Layer 0 — root"`.
- Never use the `[(...)]` cylinder shape on a subgraph.
- Quote node labels containing special characters.
- Never use the reserved word `end` as a node id.
- Build and eyeball every diagram before committing.

### Offline diagram rendering

By default `sphinxcontrib-mermaid` loads `mermaid.js` from a CDN, so diagrams
need internet to render. To make them render offline (off-grid / Starlink down):

1. Download `mermaid.min.js` into `docs/source/_static/`.
2. Uncomment the two `mermaid_version` / `html_js_files` lines in
   `docs/source/conf.py`.
