// Creates the server's keys for local development and funds its account.
//
// Writes `.dev.vars`, which `wrangler dev` loads as the Worker's secrets:
//   - MPP_PRIVATE_KEY: the payee account. It receives settled payments, and the
//     faucet gives it a little balance to start with.
//   - MPP_SECRET_KEY:  binds challenge IDs (HMAC), so they verify statelessly.
//
// Running it again keeps existing keys and only tops up the account.
import * as fs from 'node:fs'

import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const file = new URL('./.dev.vars', import.meta.url)
const vars = new Map<string, string>()
if (fs.existsSync(file))
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) vars.set(match[1]!, match[2]!)
  }

if (!vars.has('MPP_PRIVATE_KEY')) vars.set('MPP_PRIVATE_KEY', generatePrivateKey())
if (!vars.has('MPP_SECRET_KEY'))
  vars.set(
    'MPP_SECRET_KEY',
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  )

// Owner-only: the file holds the payee key and the challenge secret.
fs.writeFileSync(file, [...vars].map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {
  mode: 0o600,
})
fs.chmodSync(file, 0o600)

const account = privateKeyToAccount(vars.get('MPP_PRIVATE_KEY') as Hex)
const client = createClient({ account, chain: Chain.testnet, transport: http() })
console.log(`Server account: ${account.address}`)
console.log('Funding via testnet faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Wrote .dev.vars. Deploy the same values with `wrangler secret put <NAME>`.')
