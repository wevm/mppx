---
'mppx': minor
---

**Breaking:** Collapsed `McpClient.wrap` and the in-place `wrapClient` variant into a single `McpClient.wrap` API on the `mppx/mcp/client` entrypoint.

`McpClient.wrap` now adds payment handling to an MCP SDK client in place: the client is mutated and the same reference is returned, so surfaces that keep using the original client become payment-aware (e.g. when another SDK owns the client reference, like Cloudflare Agents). The MCP SDK `callTool(params, resultSchema?, options?)` signature is preserved, payment challenges are handled whether they arrive as payment-required errors or as tool results carrying `org.paymentauth/payment-required` metadata, and the config accepts `orderChallenges` and `paymentPreferences` alongside `methods` and `onPaymentRequired`. Calling `wrap` on the same client again replaces its payment configuration.

Migration: move per-call options from the second argument to the third — `mcp.callTool(params, undefined, { context, timeout })` — and replace the approval-first overload `mcp.callTool(onPaymentRequired, params, options)` with the `onPaymentRequired` option: `mcp.callTool(params, undefined, { onPaymentRequired })` (pass `null` to bypass a configured hook). The MCP entrypoints moved to `mppx/mcp/client` and `mppx/mcp/server`; the `mppx/mcp-sdk/*` specifiers remain as aliases.
