---
title: 'focused tests require an unavailable Tempo RPC'
severity: 'minor'
issue: 'wevm/mppx#790'
---

## Expected Behavior

Pure unit-test selection should run without requiring a Tempo RPC.

## Current Behavior

Running a unit-only `vp test` command executes the global Tempo setup and fails with ECONNREFUSED at localhost:18545 when no local RPC is running.

## Possible Solution

Document `VITE_TEMPO_NETWORK=none` for pure tests or skip global network setup when selected tests do not need it.

## Minimal Reproducible Example

Run `pnpm exec vp test run --project node --testNamePattern auth-param` without a Tempo RPC on port 18545.

## Context

This blocks focused parser unit tests until the network mode is explicitly disabled.
