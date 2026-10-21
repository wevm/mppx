// Policy unit checks: `pnpm exec tsx scripts/check-policy.ts` (no network except DNS, no key needed).
import { pad } from 'viem'

import { config } from '../src/config.ts'
import { blockedHost, checkPayment, pollsAllowed, type Quote } from '../src/policy.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

config.dryRun = false
// Pin the budget so these checks don't depend on config defaults.
config.budget = { totalUsd: 1.0, inferenceUsd: 0.5, toolsUsd: 0.5, perCallUsd: 0.1 }
for (const h of [
  'localhost',
  'printer.local',
  '127.0.0.1',
  '10.1.2.3',
  '172.20.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '[::1]',
  '[fd00::1]',
  '[::ffff:127.0.0.1]',
  new URL('http://[::ffff:127.0.0.1]/').hostname,
  'db.consul',
  'consul',
  'host.local',
  'localtest.me' /* public name resolving to 127.0.0.1 */,
])
  check(`blocked host ${h}`, !!(await blockedHost(h)), (await blockedHost(h)) ?? '')
for (const h of ['exa.mpp.tempo.xyz', 'mpp.dev', '8.8.8.8', '172.32.0.1'])
  check(`allowed host ${h}`, (await blockedHost(h)) === null)

const zero = { totalUsd: 0, llm: 0, http: 0 }
const q = (o: Partial<Quote>): Quote => ({
  quotedUsd: 0.005,
  chainId: config.chain.id,
  currency: config.token,
  host: 'exa.mpp.tempo.xyz',
  kind: 'http',
  ...o,
})
const decide = (o: Partial<Quote>, spent = zero) => checkPayment(q(o), spent)

check('normal quote allowed', decide({}).decision === 'allow')
for (const host of ['stableemail.dev', 'inbox.agentmail.to', 'api.zinc.io', 'my-billboard.xyz'])
  check(`side effect ${host}`, decide({ host }).reason === 'side effect')
config.allowSideEffectHosts = ['agentmail.to']
check('side effect allowlisted', decide({ host: 'inbox.agentmail.to' }).decision === 'allow')
config.allowSideEffectHosts = []
for (const path of ['/agentmail/v0/inboxes/x/messages/send', '/agentphone/v1/messages'])
  check(
    `side effect path ${path}`,
    decide({ host: 'mpp.orthogonal.com', path }).reason === 'side effect',
  )
check(
  'non-side-effect path allowed',
  decide({ host: 'mpp.orthogonal.com', path: '/serper/search' }).decision === 'allow',
)
check('per-call cap at limit allowed', decide({ quotedUsd: 0.1 }).decision === 'allow')
check('per-call cap exceeded', decide({ quotedUsd: 0.11 }).reason.includes('per-call cap'))
check(
  'total budget',
  decide({ quotedUsd: 0.05 }, { totalUsd: 0.98, llm: 0.49, http: 0.49 }).reason.includes('total'),
)
check(
  'tools budget split',
  decide({ quotedUsd: 0.05 }, { totalUsd: 0.5, llm: 0.03, http: 0.47 }).reason.includes(
    'http budget',
  ),
)
check(
  'inference budget split',
  decide(
    { quotedUsd: 0.05, kind: 'llm' },
    { totalUsd: 0.5, llm: 0.47, http: 0.03 },
  ).reason.includes('llm budget'),
)
check(
  'llm allowed while tools exhausted',
  decide({ quotedUsd: 0.05, kind: 'llm' }, { totalUsd: 0.5, llm: 0, http: 0.5 }).decision ===
    'allow',
)
check('wrong chain', decide({ chainId: 1 }).reason === 'unsupported payment method')
check(
  'wrong token',
  decide({ currency: pad('0x01', { size: 20 }) }) /* any token that isn't ours */.reason ===
    'unsupported payment method',
)
const jobs = { ...config.jobs, maxPollsPerWait: 60, maxPollsPerRun: 150 }
check('polls: per-wait cap', pollsAllowed(0, jobs) === 60)
check('polls: run-level cap shrinks a wait', pollsAllowed(140, jobs) === 10)
check(
  'polls: run-level cap exhausted',
  pollsAllowed(150, jobs) === 0 && pollsAllowed(999, jobs) === 0,
)
config.dryRun = true
check('dry run denies', decide({}).reason.startsWith('dry run'))

console.log(failed ? `${failed} FAILED` : 'all policy checks passed')
process.exit(failed ? 1 : 0)
