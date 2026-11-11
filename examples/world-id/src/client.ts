// Agent client — Example
//
// The server asks for World ID: the agent gets an approval link from the World ID issuer, the
// person approves in World App, and the agent's requests carry the issuer's attestation from then on. It pays 402s with Tempo
// testnet funds from the faucet.
//
//   pnpm client
//   WORLD_ID_ISSUER=https://world-id.issuer.example BASE_URL=https://api.example pnpm client
import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import * as World from 'mppx/extensions/identity/world'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4021'

const account = privateKeyToAccount(generatePrivateKey())
const client = createClient({
  account,
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(),
})
console.log('Funding the agent via the testnet faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const mppx = Mppx.create({
  identity: [
    World.Client.prover({
      issuers: [process.env.WORLD_ID_ISSUER!],
      scope: [new URL(BASE_URL).origin],
      verification: ({ url, userCode }) =>
        console.log(`\nApprove this agent with World ID: ${url}\n  code: ${userCode}\n`),
    }),
  ],
  methods: [tempo({ account, getClient: () => client })],
  polyfill: false,
})

for (const attempt of [1, 2]) {
  const response = await mppx.fetch(`${BASE_URL}/api/report`)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  const body = (await response.json()) as { report: string; paid: boolean }
  console.log(`\n--- Report ${attempt} ---`)
  console.log(`  ${body.report}`)
  if (body.paid) {
    const receipt = Receipt.fromResponse(response)
    console.log(`  paid: ${receipt.method} ${receipt.reference}`)
  } else console.log('  free (first report for this human)')
}
