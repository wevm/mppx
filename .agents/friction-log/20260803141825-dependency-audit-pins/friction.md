---
title: 'dependency audit pins become stale between dependency updates'
severity: 'minor'
---

## Expected Behavior

The required dependency audit passes on an unchanged dependency graph or is refreshed independently of feature work.

## Current Behavior

New advisories caused `pnpm audit --ignore-registry-errors` to fail every pull request until five existing transitive overrides were advanced to newly patched versions.

## Possible Solution

Run scheduled dependency-audit remediation that updates override ranges and lockfiles before unrelated pull requests encounter the required check.

## Minimal Reproducible Example

Run `pnpm audit --ignore-registry-errors` after new advisories are published against versions pinned in `pnpm-workspace.yaml`.

## Context

Observed while synchronizing an unrelated payment-offer selection pull request with `main`.
