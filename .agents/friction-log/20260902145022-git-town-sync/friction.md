---
title: 'git town sync requires a TTY in non-interactive environments'
severity: 'minor'
---

## Expected Behavior

`git town sync` completes without requiring an interactive TTY.

## Current Behavior

It fetches successfully, then fails with `could not open a new TTY: open /dev/tty: device not configured`.

## Possible Solution

Support a non-interactive mode or fall back when `/dev/tty` is unavailable.

## Minimal Reproducible Example

Run `git town sync` with stdin/stdout connected to pipes rather than a terminal.

## Context

This prevents automated contributors from following the repository-preferred sync workflow.
