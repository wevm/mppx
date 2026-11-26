---
'mppx': patch
---

Added an `onChannelOpening` option to the `tempo.session()` client, called with a new channel's entry and signed open transaction before the open credential is sent, and a `validBefore` context option that bounds when an automatic open transaction may land.
