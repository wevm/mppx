// Email OTP client — Example
//
// 1. A request without an email attestation is rejected with 401.
// 2. The Mppx client asks the issuer to email a code, prompts for it,
//    exchanges it for an attestation and retries, then pays the 402 challenge
//    with Tempo. Later requests reuse the attestation until it expires.
//
//   EMAIL=you@example.com pnpm client                # against pnpm dev
//   ISSUER=http://localhost:8787 EMAIL=you@example.com pnpm client   # local issuer
//   EMAIL=you@example.com BASE_URL=https://<worker>.workers.dev pnpm client
import * as readline from 'node:readline/promises'

import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import * as EmailOtp from 'mppx/extensions/identity/email-otp'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8788'
// The attestation issuer this client trusts with the email address.
const ISSUER = process.env.ISSUER ?? 'https://identity.mpp.tempo.xyz'
const EMAIL = process.env.EMAIL
if (!EMAIL) throw new Error('Set EMAIL to the address to verify.')

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

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
const mppx = Mppx.create({
  identity: [
    EmailOtp.Client.prover({
      email: EMAIL,
      // Asks for the code the issuer emailed.
      async code({ audience, email, error, issuer }) {
        if (error) console.log(`  ${error.message}`)
        return terminal.question(`  Code from ${issuer} sent to ${email} for ${audience}: `)
      },
      // Only this issuer receives the email address.
      issuers: [ISSUER],
      // Only this origin may ask for and receive the attestation.
      scope: [new URL(BASE_URL).origin],
    }),
  ],
  methods: [tempo({ account, getClient: () => client })],
  polyfill: false,
})

console.log('\n--- Unverified request ---')
const unverified = await fetch(`${BASE_URL}/api/report`)
console.log(`  ${unverified.status} ${unverified.headers.get('Identity-Attestation-Required')}`)

console.log('\n--- Verified, paid request ---')
const response = await mppx.fetch(`${BASE_URL}/api/report`)
terminal.close()
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
const receipt = Receipt.fromResponse(response)
const body = (await response.json()) as { report: string; email: string }
console.log(`  ${body.report} for ${body.email}`)
console.log(`  Paid: ${receipt.method} ${receipt.status} ${receipt.reference}`)
