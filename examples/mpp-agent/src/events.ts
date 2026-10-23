import { appendFileSync, mkdirSync } from 'node:fs'

import { config } from './config.ts'
import type { Kind, Spend } from './policy.ts'

export type Budget = {
  totalUsd: number
  inferenceUsd: number
  toolsUsd: number
  perCallUsd: number
}
/** Tempo Wallet mode only; absent on local-demo-wallet runs (and on runs recorded before access keys). */
type Allowance = { allowanceUsd?: number; allowanceLimitUsd?: number; allowanceExpiresAt?: string }
export type Status = 'free' | 'paid' | 'blocked' | 'failed' | 'paid_failed'
export type FinishReason = 'done' | 'budget' | 'max_steps' | 'stopped' | 'error'
/** How a wait_for job ended. */
export type JobOutcome = 'completed' | 'failed' | 'timeout' | 'stopped' | 'blocked' | 'poll_cap'
type JobProgress = {
  jobId: string
  callId?: string
  url: string
  then?: string
  polls: number
  paidPolls: number
  spentUsd: number
  elapsedMs: number
  status?: string
} // status: the last value seen at until.field (or "HTTP 202")
type Totals = {
  spentUsd: number
  payments: number
  services: number
  byService: Record<string, { calls: number; spentUsd: number }>
  byKind: { llm: number; http: number }
}

/** The event contract shared with site/site.js. */
export type Events = {
  'run.started': {
    task: string
    hints: boolean
    subagents: boolean
    model: string
    network: string
    budget: Budget
    wallet: {
      address: string
      balanceUsd: number
      mode?: 'tempo-wallet' | 'legacy'
      accessKey?: string
    } & Allowance
  }
  'agent.thought': { step: number; text: string }
  // jobId/poll/role: set on the polls and result fetch a wait_for job makes (older runs have none)
  'call.started': {
    callId: string
    step: number
    kind: Kind
    method: string
    url: string
    host: string
    reason: string
    requestExcerpt: string
    jobId?: string
    poll?: number
    role?: 'poll' | 'result'
  }
  'call.challenge': {
    callId: string
    quotedUsd: number
    currency: string
    chainId?: number
    recipient?: string
    feePayer: boolean
  }
  'call.policy': { callId: string; decision: 'allow' | 'deny'; reason: string }
  'call.paid': { callId: string; chargedUsd: number; txHashes: string[]; explorerUrls: string[] }
  'call.finished': {
    callId: string
    status: Status
    httpStatus: number
    latencyMs: number
    responseBytes: number
    responseExcerpt: string
  }
  'wallet.balance': {
    balanceUsd: number
    spentUsd: number
    spentInferenceUsd: number
    spentToolsUsd: number
    payments: number
  } & Allowance
  // wait_for: callId is the http call that submitted the job (if the harness saw its status URL), else absent.
  // job.waiting is emitted when the wait starts (polls 0) and after every poll; job.finished once.
  'job.waiting': JobProgress & {
    every_s: number
    timeout_s: number
    reason: string
    until?: { field: string; in: string[] }
  }
  'job.finished': JobProgress & { outcome: JobOutcome; message: string; resultCallId?: string }
  'run.finished': { reason: FinishReason; answer: string; totals: Totals }
  'run.error': { message: string }
}
export type Event = { type: keyof Events; runId: string; ts: string } & Record<string, unknown>

export type Run = {
  id: string
  task: string
  hints: boolean
  budget: Budget
  events: Event[]
  listeners: Set<(e: Event) => void>
  stopRequested: boolean
  finished: boolean
  calls: number
  subagents: number
  jobs: number
  polls: number // wait_for jobs and their polls; counted on the top-level run (shared with sub-agents)
  jobUrls: Map<string, string> // status/poll URL → callId of the http call that returned it
  spent: Spend & { payments: number; byService: Totals['byService'] }
  subagentsAllowed?: boolean // opt-in: a top-level run may use the spawn tool
  parent?: Run
  label?: string // set on sub-agents (one level deep)
}

export const runs = new Map<string, Run>()
mkdirSync('runs', { recursive: true })

export function createRun(
  task: string,
  hints = true,
  budget?: Budget,
  sub?: { parent: Run; label: string },
): Run {
  const id = sub
    ? `${sub.parent.id}.${sub.label}`
    : new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6)
  const run: Run = {
    id,
    task,
    hints,
    budget: budget ?? config.budget,
    events: [],
    listeners: new Set(),
    stopRequested: false,
    finished: false,
    calls: 0,
    subagents: 0,
    jobs: 0,
    polls: 0,
    jobUrls: new Map(),
    spent: { totalUsd: 0, llm: 0, http: 0, payments: 0, byService: {} },
    ...sub,
  }
  if (!sub) runs.set(id, run)
  return run
}

function write(run: Run, event: Event): void {
  run.events.push(event)
  appendFileSync(`runs/${run.id}.jsonl`, JSON.stringify(event) + '\n')
  for (const fn of run.listeners) fn(event)
}

/**
 * Sub-agents have no log of their own: their calls and thoughts go into the parent's log, tagged with the
 * sub-agent's label, so one run file still holds every payment (and on-chain verification still adds up).
 */
export function emit<T extends keyof Events>(run: Run, type: T, fields: Events[T]): void {
  const event = { type, runId: run.id, ts: new Date().toISOString(), ...fields } as Event
  if (!run.parent) return write(run, event)
  run.events.push(event)
  if (type === 'run.finished' || type === 'wallet.balance') return // the parent reports these itself
  const tagged: Event = { ...event, runId: run.parent.id, agent: run.label }
  if (type === 'call.started') tagged.reason = `${run.label}: ${event.reason as string}`
  if (type === 'agent.thought') tagged.text = `[${run.label}] ${event.text as string}`
  if (type === 'run.error') tagged.message = `${run.label}: ${event.message as string}`
  write(run.parent, tagged)
}

export function totals(run: Run): Totals {
  const { totalUsd, llm, http, payments, byService } = run.spent
  const services = Object.values(byService).filter((s) => s.spentUsd > 0).length
  return { spentUsd: totalUsd, payments, services, byService, byKind: { llm, http } }
}

export const truncate = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s

/** Pretty-print JSON, then truncate, so the LLM sees a bounded, readable response. */
export function forLlm(text: string, max = 6000): string {
  try {
    text = JSON.stringify(JSON.parse(text), null, 2)
  } catch {}
  return truncate(text, max)
}

export const usd = (n: number) => `$${n.toFixed(4)}`
/** "spent $S of $T · inference $a/$A · tools $b/$B · per-call cap $C" */
export function budgetLine(run: Run): string {
  const b = run.budget,
    s = run.spent
  const cap = (n: number) => `$${n.toFixed(2)}`
  return (
    `spent ${usd(s.totalUsd)} of ${cap(b.totalUsd)} · inference ${usd(s.llm)}/${cap(b.inferenceUsd)} · ` +
    `tools ${usd(s.http)}/${cap(b.toolsUsd)} · per-call cap ${cap(b.perCallUsd)}`
  )
}
