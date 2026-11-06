// Creates the server's and the bot's keys for local development and funds
// the server account.
//
// Writes `.dev.vars`, which `wrangler dev` loads as the Worker's secrets:
//   - MPP_PRIVATE_KEY: the payee account. It receives payments.
//   - MPP_SECRET_KEY:  binds challenge IDs (HMAC), so they verify statelessly.
//   - BOT_PUBLIC_KEY:  public JWK of the bot key the server trusts.
// and `.bot-key.json`, the bot's private Ed25519 signing key for the client.
//
// Running it again keeps existing keys and only tops up the account.
import * as fs from 'node:fs'

import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const file = new URL('../.dev.vars', import.meta.url)
const botKeyFile = new URL('../.bot-key.json', import.meta.url)
const vars = new Map<string, string>()
if (fs.existsSync(file))
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) vars.set(match[1]!, match[2]!)
  }

if (!vars.has('MPP_PRIVATE_KEY')) vars.set('MPP_PRIVATE_KEY', generatePrivateKey())
if (!vars.has('MPP_SECRET_KEY'))
  vars.set(
    'MPP_SECRET_KEY',
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  )
if (!vars.has('BOT_PUBLIC_KEY') || !fs.existsSync(botKeyFile)) {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  // Only the key's members: Workers reject the `alg` Node adds to Ed25519 JWKs.
  const { crv, kty, x } = await crypto.subtle.exportKey('jwk', keys.publicKey)
  vars.set('BOT_PUBLIC_KEY', JSON.stringify({ crv, kty, x }))
  fs.writeFileSync(
    botKeyFile,
    JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
    {
      mode: 0o600,
    },
  )
}

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
console.log(
  'Wrote .dev.vars and .bot-key.json. Deploy .dev.vars with `wrangler secret put <NAME>`.',
)
