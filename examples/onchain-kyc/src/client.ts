// Onchain KYC registry client — Example
//
// A regular Mppx client: the registry is the proof, so it needs no identity
// prover. It pays from its account, and the server checks that account against
// the registry before the payment settles.
//
//   pnpm client                                    # a new account: 403
//   PRIVATE_KEY=0x… pnpm client                    # an account you added: 200
//   BASE_URL=https://<worker>.workers.dev pnpm client
import { Receipt } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8788'

const key = (process.env.PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey()
const account = privateKeyToAccount(key)
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
  methods: [tempo({ account, getClient: () => client })],
  polyfill: false,
})

const response = await mppx.fetch(`${BASE_URL}/api/report`)
if (response.status === 403) {
  console.log(`  403 ${await response.text()}`)
  console.log('  Add this account to the registry, then run again with its key:')
  console.log(
    `    cast send $KYC_REGISTRY 'setVerified(address,bool)' ${account.address} true --rpc-url https://rpc.moderato.tempo.xyz --private-key $OPERATOR_KEY`,
  )
  if (!process.env.PRIVATE_KEY) console.log(`    PRIVATE_KEY=${key} pnpm client`)
  process.exit(1)
}
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
const receipt = Receipt.fromResponse(response)
const body = (await response.json()) as { report: string; payer: string }
console.log(`  ${body.report} for ${body.payer}`)
console.log(`  Paid: ${receipt.method} ${receipt.status} ${receipt.reference}`)
