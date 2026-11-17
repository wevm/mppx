# Manual charges for billable streams

Per-item session streams now require a generator function that calls `stream.charge()` before billable work starts. Automatic iterables and upstream SSE responses remain supported for request-priced routes and free streams. Billable SSE-enabled proxy session routes require `unitType: 'request'`; zero-priced streams remain automatic. Plain HTTP sessions still prepay each request with their configured unit label. Put per-item and request-priced session offers on separate routes. Composed one-shot charge offers and verified session management remain supported. Pass session handlers directly to proxy routes, or preserve their `_internal` metadata when wrapping them; session content is rejected when canonical pricing metadata is unavailable.

```ts
return result.withReceipt(async function* (stream) {
  while (hasMoreWork()) {
    await stream.charge()
    const value = await generateNext({ signal: stream.signal })
    yield value
  }
})
```

Determine whether more work exists without starting it. For external providers, charge the known request cost before issuing the request, then yield its result. Charges remain committed if work fails or the caller cancels. Do not advance a generator or start a provider request before awaiting the charge.

Session credentials no longer use proxy replay caching: each attempt runs the configured payment verifier and receipt transport. Composed one-shot charge offers retain replay recovery. Use a fresh funded credential when a retry requires another charge.

An automatic billable per-item stream rejected by the server credits any unused prepaid tick, even when automatic refunds are otherwise disabled. If credit cannot safely complete, the existing refund reconciliation path retains the obligation.
