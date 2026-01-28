---
name: mpay-node-http
description: mpay integration with Node.js http module. Use when building paid APIs with raw Node.js http or when asked about mpay + Node.js patterns.
---

# mpay + Node.js http

Raw Node.js `http.createServer` with `Mpay.toNodeListener`.

## Examples

### Explicit

```ts
import * as http from 'node:http'
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (url.pathname === '/fortune') {
    const result = await Mpay.toNodeListener(
      mpay.charge({
        request: {
          amount: '1000000',
          currency: '0x...',
          recipient: '0x...',
          expires: Expires.minutes(5),
        },
      }),
    )(req, res)

    if (result.status === 402) return

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ fortune: 'You will be rich' }))
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(3000)
```

### Composed

```ts
import * as http from 'node:http'
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function paid(
  config: { amount: string; currency: string; recipient: string },
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const result = await Mpay.toNodeListener(
      mpay.charge({
        request: { ...config, expires: Expires.minutes(5) },
      }),
    )(req, res)

    if (result.status === 402) return

    handler(req, res)
  }
}

const server = http.createServer(
  paid({ amount: '1000000', currency: '0x...', recipient: '0x...' }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ fortune: 'You will be rich' }))
  }),
)

server.listen(3000)
```
