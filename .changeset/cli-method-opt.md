---
"mppx": patch
---

Replaced `--channel <id>` and `--deposit <amount>` CLI flags with `-M`/`--method-opt` for passing method-specific options.

```diff
# Before
- mppx example.com/content --channel 0x123 --deposit 1000000

# After
+ mppx example.com/content -M channel=0x123 -M deposit=1000000
```
