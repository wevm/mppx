# Manual charges for billable streams

Per-item session streams now require a generator function that calls `stream.charge()` before billable work starts. Automatic iterables and upstream SSE responses remain supported for request-priced routes and free streams; proxy session routes require `unitType: 'request'`.

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

Session routes no longer use proxy replay caching: each attempt runs the configured payment verifier and receipt transport. Use a fresh funded credential when a retry requires another charge.
