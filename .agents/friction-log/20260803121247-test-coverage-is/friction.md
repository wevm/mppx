---
title: 'test coverage is configured without a coverage provider'
severity: 'minor'
issue: 'wevm/mppx#758'
---

## Expected Behavior

`vp test --coverage` reports coverage using the repository coverage configuration.

## Current Behavior

The command exits with `MISSING DEPENDENCY Cannot find dependency @vitest/coverage-v8`.

## Possible Solution

Add `@vitest/coverage-v8` as a compatible development dependency or remove the unusable coverage configuration.

## Minimal Reproducible Example

Run `pnpm exec vp test run --coverage`.

## Context

This prevents contributors from measuring the configured statement, branch, and function thresholds locally.
