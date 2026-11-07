---
'mppx': patch
---

Fixed `mppx/cloudflare`'s `channels()` lookup returning a channel opened with another operator for a challenge without one, which mppx verifies against the zero operator, and losing a matching channel behind eight newer ones with other operators: lookup entries are now keyed by operator too (`mppx:session-lookup:v3`), so channels written before resume again after their next write. Fixed `ChannelStore` replacing the immediate send that a close request written during a queue send scheduled with a later watchdog alarm.
