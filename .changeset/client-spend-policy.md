---
'mppx': patch
---

Added `maxPayment`, `authorize` (with `Budget.create`), `funders` and `tokens` options to the client and to `McpClient.wrap`, checked before any credential is created. They accept only `charge` challenges: while one is set, the client refuses sessions and subscriptions with `PaymentLimitExceededError` (`reason: 'intent'`). A credential an event handler or `onChallenge` returns, MPP or x402, is checked against the one offered challenge it pays, and a fetch built on a limited mppx fetch keeps its limits. A fetch with these options refuses the MCP tool calls `McpClient.wrap` pays itself with a `TypeError`. Added the decoded receipt, amount (a decimal string) and normalized requirement of the offer the credential pays to `payment.response` events.
