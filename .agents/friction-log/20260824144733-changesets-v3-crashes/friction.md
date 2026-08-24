---
title: 'Changesets v3 crashes on workspace package name collisions'
severity: 'minor'
---

## Expected Behavior

Changesets should report a workspace dependency graph mismatch with an actionable package name.

## Current Behavior

Changesets 3 crashes in node:util.styleText when a private workspace package has the same name as a registry dependency and no version.

## Possible Solution

Detect duplicate workspace and registry package names before formatting the expected version, or safely format undefined values.

## Minimal Reproducible Example

Create a private workspace package named stripe without a version and give it a dependency on the registry package stripe, then run pnpm changeset status.

## Context

The crash appeared after rebasing onto the Changesets 3 upgrade and hid the underlying workspace-name collision.
