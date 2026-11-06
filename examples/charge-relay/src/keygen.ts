// Creates the server's keys for local development.
//
// Writes `.dev.vars`, which `wrangler dev` loads as the Worker's secrets:
//   - MPP_PRIVATE_KEY: the payee account. It only receives payments: the relay
//     broadcasts them, so it needs no balance.
//   - MPP_SECRET_KEY:  binds challenge IDs (HMAC), so they verify statelessly.
//   - TEMPO_API_KEY:   copied from your environment when set; otherwise add
//     your Tempo API key (`mpp:write` scope) to .dev.vars yourself.
//
// Running it again keeps existing keys.
import * as fs from 'node:fs'

import { generatePrivateKey } from 'viem/accounts'

const file = new URL('../.dev.vars', import.meta.url)
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
if (!vars.has('TEMPO_API_KEY') && process.env.TEMPO_API_KEY)
  vars.set('TEMPO_API_KEY', process.env.TEMPO_API_KEY)

// Owner-only: the file holds the payee key, the challenge secret and the API key.
fs.writeFileSync(file, [...vars].map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {
  mode: 0o600,
})
fs.chmodSync(file, 0o600)

if (!vars.has('TEMPO_API_KEY'))
  console.log('Add TEMPO_API_KEY=<your Tempo API key> to .dev.vars before `pnpm dev`.')
console.log('Wrote .dev.vars. Deploy the same values with `wrangler secret put <NAME>`.')
