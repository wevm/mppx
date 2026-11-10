// Agent client — Example
//
// The agent signs every request to the server with its wallet (the `agentkit`
// header, as in x402) and pays 402s with Tempo testnet funds from the faucet.
//
// Its first report is free when the wallet is registered in AgentBook; the
// second is paid. An unregistered wallet pays for both.
//
//   pnpm client
//   BASE_URL=https://api.example AGENT_PRIVATE_KEY=0x... pnpm client
import * as fs from 'node:fs'

import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import * as World from 'mppx/extensions/identity/world'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4021'

// The agent's wallet, kept between runs so it stays registered.
const keyFile = new URL('../.agent-key', import.meta.url)
if (!process.env.AGENT_PRIVATE_KEY && !fs.existsSync(keyFile))
  fs.writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 })
const account = privateKeyToAccount(
  (process.env.AGENT_PRIVATE_KEY ?? fs.readFileSync(keyFile, 'utf8').trim()) as Hex,
)
console.log(`Agent wallet: ${account.address}`)

const client = createClient({
  account,
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(),
})
console.log('Funding the agent via the testnet faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const mppx = Mppx.create({
  identity: [World.Client.prover({ account, scope: [new URL(BASE_URL).origin] })],
  methods: [tempo({ account, getClient: () => client })],
  polyfill: false,
})

for (const attempt of [1, 2]) {
  const response = await mppx.fetch(`${BASE_URL}/api/report`)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  const body = (await response.json()) as { report: string; paid: boolean; humanId?: string }
  console.log(`\n--- Report ${attempt} ---`)
  console.log(`  ${body.report}`)
  console.log(`  human: ${body.humanId ?? 'not registered'}`)
  if (body.paid) {
    const receipt = Receipt.fromResponse(response)
    console.log(`  paid: ${receipt.method} ${receipt.reference}`)
  } else console.log('  free (human-backed agent)')
}
