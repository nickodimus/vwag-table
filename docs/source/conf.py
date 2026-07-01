# Configuration for the vwag-table developer/architecture docs.
#
# This docs system is fully self-contained: it has its own Python toolchain
# (docs/requirements.txt) and builds only the Markdown under docs/source/.
# It never touches the app runtime (the .js/.html/.css at the repo root),
# which stays vanilla-JS, no-build. Only docs/ builds.

project = "vwag-table"
author = "Sky Agnitti"
copyright = "Sky Agnitti"

extensions = [
    "myst_parser",              # write docs in Markdown
    "sphinxcontrib.mermaid",    # architecture / data-flow diagrams
]

# Markdown only (Sky writes Markdown, not reStructuredText).
source_suffix = {".md": "markdown"}

# A couple of MyST niceties used by the pages.
myst_heading_anchors = 3

myst_enable_extensions = [
    "colon_fence",   # ::: fenced directives, easier than ```{...}
    "deflist",
]

html_theme = "furo"
html_title = "vwag-table architecture"

# Trim the build: don't ship the Furo CSS source map (~76KB, dev-only).
html_css_files = []
def _drop_sourcemaps(app, exception):
    import glob, os
    out = getattr(app, "outdir", None)
    if not out:
        return
    for m in glob.glob(os.path.join(str(out), "_static", "**", "*.map"), recursive=True):
        try:
            os.remove(m)
        except OSError:
            pass

def setup(app):
    app.connect("build-finished", _drop_sourcemaps)

# --- Mermaid -----------------------------------------------------------------
# Default: sphinxcontrib-mermaid pulls mermaid.js from a CDN at page-load.
# That renders fine at a desk with internet. To make the docs render diagrams
# OFFLINE (off-grid / Starlink down), vendor mermaid locally:
#   1. download mermaid.min.js into docs/source/_static/
#   2. uncomment the two lines below
# mermaid_version = ""                       # disable the CDN auto-include
# html_js_files = ["mermaid.min.js"]         # load the vendored copy instead
