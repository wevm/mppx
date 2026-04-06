// WebSocket Streaming Payment Client — Example

//
// This example demonstrates the client side of a metered WebSocket session.
// The websocket transport is still bootstrapped by an HTTP 402 challenge:
//
//   1. Client probes `/ws/chat` over HTTP and receives a `402` challenge
//   2. Client opens an on-chain channel and creates the first credential
//   3. Client opens a WebSocket and sends that credential as the first frame
//   4. Server streams tokens and emits `payment-need-voucher` frames when the
//      current cumulative voucher is exhausted
//   5. Client signs and sends voucher updates over the same socket
//   6. Client sends a final `close()` credential to settle on-chain

import { WebSocket } from 'isows'
// `tempo` from 'mppx/client' provides the session manager used for this demo.
import { tempo } from 'mppx/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

// The server URL. The websocket URL is derived from this base.
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

// pathUSD on Tempo testnet.
const currency = '0x20c0000000000000000000000000000000000000' as const

// The per-token price configured on the server.
const PRICE_PER_TOKEN = '0.000075'

// Client Account Setup

//
// Generate a demo payer account unless the caller provides a persistent key via
// `PRIVATE_KEY`. Reusing a real key is convenient when presenting multiple demo
// runs and wanting a stable wallet address.
const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

// The client needs a viem client with the payer account attached because Tempo
// session credentials include signed vouchers and, on first use, a signed open
// transaction for the payment channel.
const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

// Fund the payer account via the public testnet faucet so it has pathUSD for
// the channel deposit and enough gas to get through the open/close lifecycle.
console.log(`Client account: ${account.address}`)
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

// Helper to query the payer's current pathUSD balance.
const getBalance = () => Actions.token.getBalance(client, { account, token: currency })

// Format raw 6-decimal token values for terminal output.
const fmt = (value: bigint) => `${Number(value) / 1e6} pathUSD`

const balanceBefore = await getBalance()
console.log(`Balance: ${fmt(balanceBefore)}`)

// Step 1: Create a Session Manager

//
// `tempo.session()` returns a stateful session manager. For WebSocket flows it
// still handles the hard parts: HTTP challenge probing, channel open, voucher
// creation, cumulative accounting, and final close.
//
// We pass the `ws` package's constructor explicitly because Node 18 does not
// provide a reliable global `WebSocket` in the same way browsers do.
const session = tempo.session({
  account,
  client,
  maxDeposit: '1',
  webSocket: WebSocket as any,
})

// Step 2: Build the WebSocket URL

//
// The example derives the socket URL from `BASE_URL` so the same code works
// against localhost or a remote deployment. The prompt is sent as a query
// parameter because the websocket content request itself has no HTTP body.
const prompt = process.argv[2] ?? 'Tell me something interesting'
const url = new URL(BASE_URL)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
url.pathname = '/ws/chat'
url.searchParams.set('prompt', prompt)

console.log(`\n--- Channel ---`)
console.log(`Max deposit: 1 pathUSD`)
console.log(`Price per token: ${PRICE_PER_TOKEN} pathUSD`)
console.log(`Endpoint: ${url}`)

// Step 3: Open the Paid WebSocket Session

//
// `session.ws()` performs the initial HTTP 402 probe, creates the first
// payment credential, opens the websocket, and sends the auth frame.
//
// The optional `onReceipt` callback gives us visibility into the voucher and
// spend progression while the stream is active.
let receiptCount = 0
const socket = await session.ws(url, {
  onReceipt(receipt) {
    receiptCount++
    console.log(
      `\n[receipt ${receiptCount}] spent=${fmt(BigInt(receipt.spent))} accepted=${fmt(BigInt(receipt.acceptedCumulative))}`,
    )
  },
})

// Step 4: Read Streamed Tokens

//
// Application data arrives as ordinary websocket text messages. Payment control
// frames (`payment-need-voucher`, `payment-receipt`) are intercepted internally
// by `session.ws()`, so the demo loop here only needs to print the content.
console.log(`\n--- Streaming (prompt: "${prompt}") ---`)

let tokenCount = 0
await new Promise<void>((resolve, reject) => {
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    tokenCount++
    process.stdout.write(event.data)
  })
  socket.addEventListener('close', () => resolve(), { once: true })
  socket.addEventListener('error', () => reject(new Error('websocket stream failed')), {
    once: true,
  })
})

// Step 5: Close and Settle

//
// Once the content stream ends, we send a final `close` credential so the
// server can settle the channel and return a final receipt with the accepted
// cumulative amount and, when available, the close transaction hash.
console.log(`\n\nTokens: ${tokenCount}`)
console.log(`Voucher cumulative: ${fmt(session.cumulative)}`)

console.log(`\n--- Settlement ---`)
const closeReceipt = await session.close()
if (closeReceipt) {
  console.log(`  Channel:    ${closeReceipt.channelId}`)
  console.log(`  Settled:    ${fmt(BigInt(closeReceipt.acceptedCumulative))}`)
  console.log(`  Tokens:     ${closeReceipt.units}`)
  if (closeReceipt.txHash) console.log(`  Settle tx:  ${closeReceipt.txHash}`)
}

// Give the settlement transaction a few seconds to finalize before checking
// the post-session balance so the summary is easier to interpret live.
await new Promise((resolve) => setTimeout(resolve, 5_000))

const balanceAfter = await getBalance()
const totalSpent = balanceBefore - balanceAfter

// Step 6: Summary

//
// `session.cumulative` is the total voucher amount the client authorized.
// The balance delta is usually larger because it also includes gas for the
// open/close transactions.
console.log(`\n--- Summary ---`)
console.log(`  Tokens streamed: ${tokenCount}`)
console.log(`  Voucher total:   ${fmt(session.cumulative)}`)
console.log(`  Balance before:  ${fmt(balanceBefore)}`)
console.log(`  Balance after:   ${fmt(balanceAfter)}`)
console.log(`  Total spent:     ${fmt(totalSpent)} (voucher + gas)`)
