---
'mppx': patch
---

Fixed `Challenge.deserialize` and `Challenge.serialize` to follow the MPP core grammar: payment method identifiers must be `1*LOWERALPHA` (a-z only), and a backslash in a quoted-string is a quoted-pair, so `\u2014` parses to the text `u2014` instead of being decoded. `Challenge.serialize` now throws for characters above U+00FF in any parameter except `description`, which keeps its `\uXXXX` escape so a 402 never fails on an em dash or emoji.
