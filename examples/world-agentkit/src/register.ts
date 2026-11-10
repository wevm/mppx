// Registers the agent in AgentBook on a local World Chain fork — Example
//
// Real registration needs a World ID proof from World App:
//
//   npx @worldcoin/agentkit-cli register <agent-address>
//
// To try the flow without World App, fork World Chain with Anvil and write the
// registration into the real AgentBook contract's storage:
//
//   anvil --fork-url https://worldchain-mainnet.g.alchemy.com/public
//   pnpm register              # registers the wallet in .agent-key
import * as fs from 'node:fs'

import * as World from 'mppx/extensions/identity/world'
import { createTestClient, encodeAbiParameters, type Hex, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC_URL = process.env.WORLD_RPC_URL ?? 'http://127.0.0.1:8545'
// AgentBook's `lookupHuman` mapping is at storage slot 4.
const LOOKUP_HUMAN_SLOT = 4n

const key = (process.env.AGENT_PRIVATE_KEY ??
  fs.readFileSync(new URL('../.agent-key', import.meta.url), 'utf8').trim()) as Hex
const agent = privateKeyToAccount(key).address
// Stands in for the World ID nullifier hash a real registration records.
const humanId = BigInt(keccak256(toHex(`demo-human:${agent}`)))

const client = createTestClient({ mode: 'anvil', transport: http(RPC_URL) })
await client.setStorageAt({
  address: World.Constants.agentBook,
  index: keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [agent, LOOKUP_HUMAN_SLOT]),
  ),
  value: toHex(humanId, { size: 32 }),
})

const registered = await World.Server.agentBook({ rpcUrl: RPC_URL })(agent)
console.log(`Registered ${agent} in AgentBook on ${RPC_URL}: human ${registered}`)
