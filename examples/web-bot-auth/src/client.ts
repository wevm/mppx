// Web Bot Auth bot client — Example
//
// 1. An unsigned request is rejected before any payment challenge.
// 2. The Mppx client signs every in-scope HTTP attempt (the first request
//    and the payment retry) with fresh Web Bot Auth headers, then pays the
//    402 challenge with Tempo.
//
//   pnpm client                              # against pnpm dev
//   BASE_URL=https://<worker>.workers.dev pnpm client
import * as fs from 'node:fs'

import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787'
// The bot's HTTPS directory, which the server trusts.
const signatureAgent = 'https://bot.example'

// The bot's Ed25519 key pair, written by `pnpm keygen`. The prover derives its
// keyid, the RFC 7638 thumbprint of the public key.
const jwk = JSON.parse(
  fs.readFileSync(new URL('../.bot-key.json', import.meta.url), 'utf8'),
) as JsonWebKey
const key: CryptoKeyPair = {
  privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']),
  publicKey: await crypto.subtle.importKey(
    'jwk',
    { crv: jwk.crv, kty: jwk.kty, x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  ),
}

const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())
const client = createClient({
  account,
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(),
})
console.log(`Client account: ${account.address}`)
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const mppx = Mppx.create({
  identity: [
    WebBotAuth.Client.prover({
      key,
      // Only these origins receive the signature.
      scope: [new URL(BASE_URL).origin],
      signatureAgent,
    }),
  ],
  methods: [tempo({ account, getClient: () => client })],
  polyfill: false,
})

console.log('\n--- Unsigned request ---')
const unsigned = await fetch(`${BASE_URL}/api/report`)
console.log(`  ${unsigned.status} ${unsigned.statusText}`)

console.log('\n--- Signed, paid request ---')
const response = await mppx.fetch(`${BASE_URL}/api/report`)
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
const receipt = Receipt.fromResponse(response)
const body = (await response.json()) as { report: string; bot: { keyId: string } }
console.log(`  ${body.report} for bot ${body.bot.keyId}`)
console.log(`  Paid: ${receipt.method} ${receipt.status} ${receipt.reference}`)
