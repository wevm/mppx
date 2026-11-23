---
'mppx': patch
---

Fixed `Challenge.deserialize` and `Challenge.serialize` to follow the MPP core grammar: payment method identifiers must be `1*LOWERALPHA` (a-z only), and a backslash in a quoted-string is a quoted-pair, so `\u2014` parses to the text `u2014` instead of being decoded. `Challenge.serialize` now throws for characters above U+00FF in any parameter except `description`, which keeps its `\uXXXX` escape so a 402 never fails on an em dash or emoji.

`Mppx.create` now throws at startup for a method name outside a-z, or for a `realm` above U+00FF on a transport that sends the Challenge in a header, instead of failing on every 402. `Challenge.deserializeList` skips an offer whose method id is outside a-z rather than rejecting the whole header, and the client keys payment retries without building a header or reading the display-only `description`.

The client now refuses a challenge from a server that escaped a bound parameter (any but `description`) as `\uXXXX`, as servers before quoted-pair parsing did for characters above U+00FF: it skips such an offer when another is payable, and otherwise throws `Errors.LegacyUnicodeEscapedChallengeError` before creating, signing or broadcasting anything, since the server would reject the credential.
