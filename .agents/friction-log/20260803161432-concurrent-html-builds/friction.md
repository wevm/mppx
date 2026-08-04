---
title: 'concurrent HTML builds share a temporary directory'
severity: 'minor'
issue: 'wevm/mppx#761'
---

## Expected Behavior

Running pnpm build and pnpm check:types concurrently completes independently.

## Current Behavior

Both commands invoke the HTML builder against .tmp/html-build. One process removes the directory while the other still uses it, causing an ENOENT failure during cleanup.

## Possible Solution

Give each HTML build a unique temporary directory or make cleanup tolerate concurrent removal.

## Minimal Reproducible Example

Run pnpm build and pnpm check:types concurrently in the same worktree.

## Context

This prevents safely parallelizing independent validation commands.
