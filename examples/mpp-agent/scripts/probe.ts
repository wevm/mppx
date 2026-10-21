// Unpaid probe through paidFetch: decodes the quote and runs policy, but DRY_RUN forces deny so nothing is paid.
// DRY_RUN=1 pnpm exec tsx scripts/probe.ts [url]
import { config } from '../src/config.ts'
import { createRun } from '../src/events.ts'
import { paidFetch } from '../src/paidFetch.ts'

if (!config.dryRun) throw new Error('refusing to run without DRY_RUN=1')
const run = createRun('probe')
run.listeners.add((e) => console.log(JSON.stringify(e)))
const url = process.argv[2] ?? 'https://firecrawl.mpp.tempo.xyz/v1/search'
const r = await paidFetch(run, { step: 1, kind: 'http', reason: 'unpaid probe' }, url, {
  method: 'POST',
  body: JSON.stringify({ query: 'test', limit: 1 }),
})
console.log('result:', r.status, r.reason)
