---
name: mpay-client
description: mpay client-side integration. Use when building apps that make paid requests, handling 402 responses, or when asked about mpay client patterns.
---

# mpay Client

Three approaches for handling 402 Payment Required responses on the client.

## 1. Fetch Polyfill

Replaces global `fetch` with a payment-aware wrapper. Best for apps where all requests should auto-pay.

```ts
import { Fetch, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

Fetch.polyfill({
  methods: [
    tempo.charge({
      account: privateKeyToAccount('0x...'),
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://api.example.com/resource')

// Restore original fetch when done
Fetch.restore()
```

## 2. Fetch Wrapper

Creates a wrapped fetch function. Best when you want explicit control over which requests are payment-aware.

```ts
import { Fetch, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const fetch = Fetch.from({
  methods: [
    tempo.charge({
      account: privateKeyToAccount('0x...'),
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})

// Use wrapped fetch — handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

### Per-Request Context

Pass context to override account per-request:

```ts
import { Fetch, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const fetch = Fetch.from({
  methods: [
    tempo.charge({
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})

const res = await fetch('https://api.example.com/resource', {
  context: { account: privateKeyToAccount('0x...') },
})
```

## 3. Manual

Full control over the 402 flow. Best when you need custom logic between challenge and retry.

```ts
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})

const response = await fetch('/resource')

if (response.status === 402) {
  const credential = await mpay.createCredential(response, {
    account: privateKeyToAccount('0x...'),
  })

  // Retry with credential
  const paidResponse = await fetch('/resource', {
    headers: { Authorization: credential },
  })
}
```

## Comparison

| Approach | When to Use |
|----------|-------------|
| **Polyfill** | Global auto-pay, all requests should handle 402 |
| **Wrapper** | Explicit payment-aware fetch, scoped usage |
| **Manual** | Custom logic, UI prompts, conditional payments |
