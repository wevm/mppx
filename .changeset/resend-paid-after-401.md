---
'mppx': patch
---

Changed the identity client to resend a paid request once after a 401, when a prover's `retry` asks to, with refreshed identity and the same Payment credential while its Challenge has not expired, unless the 401 carries a receipt. A 401 never follows settlement, so this recovers from expired identity without paying twice. Paid requests are still never resent after a 403 or any other response. If a retry hook or re-proving fails, or the Challenge expires first, the 401 is returned without resending. The rejected response is released before re-proving, and the Link claims prover reads at most 64 KiB of a challenge body, giving up after 2 seconds or when the request aborts.
