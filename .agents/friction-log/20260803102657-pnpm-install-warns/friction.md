---
title: 'pnpm install warns about missing local dist/bin.js links'
severity: 'minor'
---

## Expected Behavior

A fresh worktree installs dependencies without warnings before the first build.

## Current Behavior

Running `pnpm check:types` triggers dependency installation and emits repeated `ENOENT` warnings while linking the local `mppx` binary because `dist/bin.js` does not exist yet. Installation and the subsequent build still succeed.

## Possible Solution

Avoid linking the workspace binary before it is built, or provide a stable source entry for workspace links.

## Minimal Reproducible Example

In a fresh worktree, run `pnpm check:types`.

## Context

Observed while validating removal of the legacy Tempo session implementation.
