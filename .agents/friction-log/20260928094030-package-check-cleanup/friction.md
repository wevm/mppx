---
title: 'Package check cleanup reinstalls dependencies with the publish manifest'
severity: 'minor'
---

### Expected Behavior

Package validation restores the development manifest without reinstalling dependencies.

### Current Behavior

The package file and size checks pass. Cleanup invokes pnpm exec zile publish:post while package.json is still the publication manifest. pnpm then attempts dependency repair, removing test dependencies and stalling cleanup.

### Possible Solution

Restore package.tmp.json before invoking pnpm, or invoke the existing zile binary directly.

### Minimal Reproducible Example

Run node --import tsx scripts/check:package.ts from main revision dcf15895 with pnpm 11.0.8.

### Context

Observed during local package validation. Restored package.tmp.json and reinstalled the locked dependencies to recover.
