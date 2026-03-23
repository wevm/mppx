/**
 * Token-gate example server.
 *
 * Token holders (ERC-721 NFT on Base) get free access to the protected route.
 * Non-holders go through the normal Tempo payment flow.
 *
 * The payer's address is read from `credential.source` — no extra client-side
 * signing is required beyond the standard payment credential.
 *
 * Run:
 *   MPPX_RPC_URL=... NFT_CONTRACT=0x... node --import tsx src/server.ts
 */

import { Mppx, tempo } from 'mppx/server'
import { tokenGate } from 'mppx/token-gate'
import { Receipt } from 'mppx'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c0000000000000000000000000000000000000' as const // pathUSD

const NFT_CONTRACT = (process.env.NFT_CONTRACT ?? '0x0000000000000000000000000000000000000001') as `0x${string}`

// ---------------------------------------------------------------------------
// Build token-gated tempo charge method
// ---------------------------------------------------------------------------

const tempoCharge = tempo({
  currency,
  feePayer: true,
  recipient: account.address,
  testnet: true,
})

const gatedCharge = tokenGate(tempoCharge, {
  contracts: [
    {
      address: NFT_CONTRACT,
      chain: base,
      type: 'ERC-721',
    },
  ],
  // cacheTtlSeconds: 300 (default — 5 min)
})

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const mppx = Mppx.create({ methods: [gatedCharge] })

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Health — always free
  if (url.pathname === '/api/health') {
    return Response.json({ status: 'ok' })
  }

  // Protected — free for NFT holders, paid for everyone else
  if (url.pathname === '/api/data') {
    const result = await mppx.charge({
      amount: '0.01',
      description: 'Exclusive data — free for NFT holders',
    })(request)

    if (result.status === 402) return result.challenge

    const response = Response.json({ data: 'exclusive content' })
    const wrapped = result.withReceipt(response)

    // Log whether access was free (token-gated) or paid
    const receiptHeader = wrapped.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      const via = receipt.reference === 'token-gate:free' ? 'free (token holder)' : `paid (${receipt.reference})`
      console.log(`[access] /api/data — ${via}`)
    }

    return wrapped
  }

  return null
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})

await Actions.faucet.fundSync(client, { account })
console.log(`[server] recipient: ${account.address}`)
console.log(`[server] NFT contract: ${NFT_CONTRACT}`)
console.log(`[server] token holders get free access to /api/data`)
