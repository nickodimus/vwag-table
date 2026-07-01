# vwag-table — architecture & developer docs

Developer-facing documentation for **`vwag-table`**: a vanilla-JavaScript,
ES-module, no-build browser VTT (virtual tabletop) that drives a physical
IR touch table and an online play tier. This is the *codebase* documentation —
how the modules fit together and why. For the GM-facing walkthrough, see the
shipped `manual.html` instead.

The whole point of this doc set is to show how the codebase is put together:
one orchestrator (`main.js`) on top of a clean, acyclic graph of ~23 focused
ES modules, with a small set of patterns (`hooks`, `controls`, the render/sync
split) that keep the graph free of circular dependencies.

```{toctree}
:maxdepth: 2
:caption: Contents

architecture
data-flow
coordinate-model
modules/index
contributing
```

## Ground rules for this codebase

- **No build step.** The app is served static: `python3 -m http.server` and go,
  runs offline. This docs system has its own isolated Python toolchain under
  `docs/` and never touches the app runtime.
- **Source-first.** Every architectural claim in these pages was read from the
  actual code, not inferred from a filename.
- **Lockstep.** When a module changes materially, its docs page changes in the
  same chunk.
