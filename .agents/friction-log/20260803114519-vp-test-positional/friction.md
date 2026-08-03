---
title: 'vp test positional paths do not select test files'
severity: 'minor'
---

## Expected Behavior

`pnpm test src/server/Mppx.test.ts` runs the selected Node test file without unrelated integration setup.

## Current Behavior

The command reports no matching test files, then executes global Tempo setup and fails when localhost:18545 is unavailable.

## Possible Solution

Document or support a focused Node-test command that accepts repository-relative paths and skips unrelated global setup.

## Minimal Reproducible Example

Run `pnpm test src/server/Mppx.test.ts` without a Tempo localnet on port 18545.

## Context

This blocks fast iteration on isolated server unit tests.
