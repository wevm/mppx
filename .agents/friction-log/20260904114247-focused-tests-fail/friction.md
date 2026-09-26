---
title: 'Focused tests fail before HTML composition is generated'
severity: 'minor'
issue: 'wevm/mppx#868'
---

## Expected Behavior

Focused server tests run in a clean worktree.

## Current Behavior

The test import fails because `src/server/internal/html/compose.main.gen.js` has not been generated.

## Possible Solution

Generate required composition modules in test setup or avoid importing generated HTML from unrelated focused tests.

## Minimal Reproducible Example

From a clean worktree, run `VITE_TEMPO_NETWORK=none pnpm test -- --project node src/tempo/session/server/Session.test.ts`.

## Context

This blocks focused unit-test reproduction until `pnpm build` is run.
