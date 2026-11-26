// One real paid call through paidFetch (no agent). Usage: tsx scripts/paid-call.ts <url> '<json body>'
import { createRun } from '../src/events.ts'
import { paidFetch } from '../src/paidFetch.ts'
const [url, body] = process.argv.slice(2)
const run = createRun(`paid-call ${url}`)
const t0 = Date.now()
const r = await paidFetch(run, { step: 1, kind: 'http', reason: 'video endpoint test' }, url, {
  method: 'POST',
  body,
})
console.log(
  JSON.stringify({
    status: r.status,
    httpStatus: r.httpStatus,
    costUsd: r.costUsd,
    seconds: (Date.now() - t0) / 1000,
    reason: r.reason,
  }),
)
console.log(r.text.slice(0, 1500))
process.exit(0)
