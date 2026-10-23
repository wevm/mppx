// `pnpm run migrate`: move USDC.e from a local demo wallet (an earlier setup) to the Tempo Wallet this agent is approved for.
// Flags: --yes (don't ask), --dry-run (show what would move; sends nothing). The local key is never deleted here.
import { config } from '../src/config.ts'
import { describeLegacy, readAccessKey, readKey } from '../src/keystore.ts'
import { runMigration } from '../src/migrate.ts'

const args = process.argv.slice(2)
const key = readKey()
const r = readAccessKey()
if (!key) console.log(`\nNo local demo wallet key in ${describeLegacy()}: nothing to migrate.\n`)
else if (!r || r.chainId !== config.chain.id) {
  console.log(
    '\nApprove this agent in your Tempo Wallet first, so there is somewhere to move the funds: pnpm run setup\n',
  )
  process.exitCode = 1
} else {
  console.log(`\nLocal demo wallet (${describeLegacy()}) → Tempo Wallet ${r.wallet}`)
  await runMigration(key, r.wallet, {
    yes: args.includes('--yes'),
    dryRun: args.includes('--dry-run'),
  })
  console.log('')
}
