# Minimal Sphinx makefile for the vwag-table docs.
SPHINXBUILD ?= sphinx-build
SOURCEDIR    = source
BUILDDIR     = build

help:
	@$(SPHINXBUILD) -M help "$(SOURCEDIR)" "$(BUILDDIR)"

html:
	@$(SPHINXBUILD) -b html "$(SOURCEDIR)" "$(BUILDDIR)/html"

clean:
	@rm -rf "$(BUILDDIR)"

.PHONY: help html clean
