import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { config } from './config.ts'

export type Kind = 'llm' | 'http'
export type Decision = { decision: 'allow' | 'deny'; reason: string }
export type Spend = { totalUsd: number; llm: number; http: number }
export type Quote = {
  quotedUsd: number
  chainId?: number
  currency: string
  host: string
  path?: string
  kind: Kind
}

const BLOCKED_SUFFIXES = ['.local', '.consul']
// Matched against host + path, so aggregator routes (e.g. mpp.orthogonal.com/agentmail) are caught too.
const SIDE_EFFECT = [
  'stableemail.dev',
  'agentmail',
  'postalform.com',
  'papercut.lol',
  'stableprint.dev',
  'stablemerch.dev',
  'stablephone.dev',
  'agentphone',
  'agentfax',
  'emboss',
  'zinc',
  'agentres',
  'ticketwallet',
  'wurk',
  'molty.cash',
  'grov',
  'billboard',
  'doma.xyz',
  'megapot',
  'laso.finance',
  'buildwithlocus',
  'top-up',
  'prepaid-tokens',
  'tempvpn',
  'codestorage',
  '/sms',
  '/send',
  '/push',
  'webhook',
]

export function isPrivateIp(ip: string): boolean {
  ip = ip.toLowerCase().replace(/^::ffff:/, '') // IPv4-mapped IPv6, also in hex form (::ffff:7f00:1)
  const hex = ip.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex)
    ip = [hex[1], hex[2]].flatMap((h) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255]).join('.')
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) // fc00::/7, fe80::/10
}

/** Returns a reason if the host must never be requested, else null. Resolves DNS to stop rebinding. */
export async function blockedHost(hostname: string): Promise<string | null> {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    BLOCKED_SUFFIXES.some((s) => h.endsWith(s) || h === s.slice(1))
  )
    return `blocked host ${h}`
  if (isIP(h)) return isPrivateIp(h) ? `blocked private address ${h}` : null
  const addrs = await lookup(h, { all: true }).catch(() => [])
  const bad = addrs.find((a) => isPrivateIp(a.address))
  return bad ? `blocked: ${h} resolves to private address ${bad.address}` : null
}

export function isSideEffectHost(host: string, path = ''): boolean {
  const h = host.toLowerCase(),
    target = h + path.toLowerCase()
  if (config.allowSideEffectHosts.some((a) => h === a || h.endsWith('.' + a))) return false
  return SIDE_EFFECT.some((s) => target.includes(s))
}

/** Decide whether to pay a quote, given what this run has spent so far. */
export function checkPayment(q: Quote, spent: Spend, budget = config.budget): Decision {
  const deny = (reason: string): Decision => ({ decision: 'deny', reason })
  const kindBudget = q.kind === 'llm' ? budget.inferenceUsd : budget.toolsUsd
  if (isSideEffectHost(q.host, q.path)) return deny('side effect')
  if (q.chainId !== config.chain.id || q.currency.toLowerCase() !== config.token.toLowerCase())
    return deny('unsupported payment method')
  // Checked against the quote only: on non-fee-sponsored services the charged amount adds a little gas on top.
  if (q.quotedUsd > budget.perCallUsd)
    return deny(`quote $${q.quotedUsd} exceeds per-call cap $${budget.perCallUsd}`)
  if (spent.totalUsd + q.quotedUsd > budget.totalUsd + 1e-9)
    return deny('budget: total budget exhausted')
  if (spent[q.kind] + q.quotedUsd > kindBudget + 1e-9)
    return deny(`budget: ${q.kind} budget exhausted`)
  if (config.dryRun) return deny('dry run: payments disabled')
  return {
    decision: 'allow',
    reason: `within budget ($${(budget.totalUsd - spent.totalUsd).toFixed(4)} left)`,
  }
}

/** wait_for: how many polls one wait may make, given the run's polls so far (run-level cap) and the per-wait cap. */
export function pollsAllowed(runPolls: number, jobs = config.jobs): number {
  return Math.max(0, Math.min(jobs.maxPollsPerWait, jobs.maxPollsPerRun - runPolls))
}
