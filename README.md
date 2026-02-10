# mpay

TypeScript SDK for the [**Machine Payments Protocol**](https://machinepayments.dev).

[![npm](https://img.shields.io/npm/v/mpay.svg)](https://www.npmjs.com/package/mpay)
[![License](https://img.shields.io/npm/l/mpay.svg)](LICENSE)

## Documentation

Full documentation, API reference, and guides are available at **[machinepayments.dev/sdk/typescript](https://machinepayments.dev/sdk/typescript)**.

## Install

```bash
npm i mpay
```
```bash
pnpm add mpay
```
```bash
bun add mpay
```

## Quick Start

### Server

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
})

export async function handler(request: Request) {
  const response = await mpay.charge({ amount: '1' })(request)

  if (response.status === 402) return response.challenge

  return response.withReceipt(Response.json({ data: '...' }))
}
```

### Client

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Mpay, tempo } from 'mpay/client'

Mpay.create({
  methods: [tempo({ account: privateKeyToAccount('0x...') })],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

## Examples

| Example | Description |
|---------|-------------|
| [basic](./examples/basic/) | Bun server with pay-per-request fortune API |
| [stream](./examples/stream/) | Streaming payment channels with per-token LLM metering |

```bash
npx gitpick wevm/mpay/examples/basic
```
```bash
pnpx gitpick wevm/mpay/examples/basic
```
```bash
bunx gitpick wevm/mpay/examples/basic
```

## CLI

mpay includes a basic CLI for making HTTP requests with automatic payment handling.

```bash
# create account - stored in keychain, autofunded on testnet
pnpm mpay account create

# make request - automatic payment handling, curl-like api
pnpm mpay example.com
```

<details>
<summary><code>mpay --help</code></summary>

```
mpay/0.1.0

Usage:
  $ mpay [url]

Commands:
  [url]             Make HTTP request with automatic payment
  account [action]  Manage accounts (create, delete, fund, list, view)

For more info, run any command with the `--help` flag:
  $ mpay --help
  $ mpay account --help

Actions:
  create  Create new account
  delete  Delete account
  fund    Fund account with testnet tokens
  list    List all accounts
  view    View account address

Options:
  -A, --user-agent <ua>  Set User-Agent header
  -d, --data <data>      Send request body (implies POST unless -X is set)
  -f, --fail             Fail silently on HTTP errors (exit 22)
  -H, --header <header>  Add header (repeatable)
  -i, --include          Include response headers in output
  -k, --insecure         Skip TLS certificate verification (true for localhost/.local)
  -L, --location         Follow redirects
  -s, --silent           Silent mode (suppress progress and info)
  -v, --verbose          Make operation more talkative
  -X, --method <method>  HTTP method
  --accept <type>        Set Accept header (e.g. json, markdown, text/html)
  --account <name>       Account name (default: default)
  --json <json>          Send JSON body (sets Content-Type, implies POST)
  -M, --mainnet          Use mainnet
  --rpc-url <url>        Custom RPC URL
  --yes                  Skip confirmation prompts
  --deposit <amount>     Deposit amount for stream payments (human-readable units)
  -V, --version          Display version number
  -h, --help             Display this message
```

</details>

### Global Install

Install globally to use `mpay` from anywhere:

```bash
npm i -g mpay
```
```bash
pnpm add -g mpay
```
```bash
bun add -g mpay
```

## Protocol

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/). See [payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec) for the full specification.

## License

MIT
