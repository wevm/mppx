---
title: 'pnpm checks abort while attempting non-interactive dependency repair'
severity: 'minor'
---

## Expected Behavior

`pnpm check:types` runs the documented type check, or reports a non-interactive dependency problem with an actionable command.

## Current Behavior

The command invokes `pnpm install` and aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, so validation cannot start.

## Possible Solution

Avoid implicit interactive dependency repair for check commands, or provide a CI-safe fallback and clear remediation.

## Minimal Reproducible Example

Run `pnpm check:types` in a non-TTY workspace where pnpm decides the modules directory needs repair.

## Context

This blocked validation of a source change in this repository.
