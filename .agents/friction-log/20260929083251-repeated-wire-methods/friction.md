---
title: 'Repeated wire methods overwrite currency offers during implicit composition'
severity: 'minor'
---

## Expected Behavior

Each configured currency produces its own offer in list order.

## Current Behavior

Registering two tempo/charge methods with different currency defaults repeats the final currency.

## Possible Solution

Resolve handlers by configured method identity.

## Minimal Reproducible Example

Register two tempo charge factories with distinct currency defaults, then call the shorthand charge handler.

## Context

Found while adding default OUSD and USDC.e acceptance; covered by HTTP offer tests.
