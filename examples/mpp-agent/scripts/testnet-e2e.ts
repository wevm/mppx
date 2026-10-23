// One real paid call on the Moderato TESTNET with a throwaway key (never printed). pnpm exec tsx scripts/testnet-e2e.ts
import { generatePrivateKey } from 'viem/accounts'

Object.assign(process.env, {
  MPP_NETWORK: 'testnet',
  MPP_KEY_SOURCE: 'env',
  MPP_PRIVATE_KEY: generatePrivateKey(),
  DRY_RUN: '',
})
const { config } = await import('../src/config.ts')
const { account, balanceUsd, chain } = await import('../src/wallet.ts')
const { createRun } = await import('../src/events.ts')
const { paidFetch } = await import('../src/paidFetch.ts')
const { Actions } = await import('viem/tempo')
if (config.chain.id !== 42431) throw new Error('not on testnet')

console.log('throwaway testnet wallet', account.address)
const hashes = await Actions.faucet.fund(chain, { account: account.address })
await Promise.all(hashes.map((hash) => chain.waitForTransactionReceipt({ hash })))
console.log('funded, pathUSD balance', await balanceUsd())

const run = createRun('testnet e2e')
run.listeners.add((e) =>
  console.log(JSON.stringify({ ...e, runId: undefined, ts: undefined, requestExcerpt: undefined })),
)
const r = await paidFetch(
  run,
  { step: 1, kind: 'http', reason: 'testnet paid ping' },
  'https://mpp.dev/api/ping/paid',
)
console.log(
  'result',
  r.status,
  r.httpStatus,
  'cost',
  r.costUsd,
  r.costIsQuote ? '(quoted)' : '(charged)',
  'balance',
  await balanceUsd(),
)
