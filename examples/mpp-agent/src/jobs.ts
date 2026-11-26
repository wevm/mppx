// Async paid jobs: submit with the http tool, then wait_for polls in code, with no LLM steps in between.
// Every poll and the final `then` fetch go through the fetcher agent.ts passes in (always paidFetch), so the host
// blocklist, policy, budget, allowance check and receipts apply exactly as for any http call. This module never
// imports the wallet: the offline check (scripts/check-wait.ts) drives it with a mock fetcher instead.
import { config } from './config.ts'
import { budgetLine, emit, forLlm, usd, type JobOutcome, type Run } from './events.ts'
import type { CallResult, JobTag } from './paidFetch.ts'
import { pollsAllowed } from './policy.ts'

export type Fetcher = (
  url: string,
  init: RequestInit,
  ctx: { step: number; kind: 'http'; reason: string; job: JobTag },
) => Promise<CallResult>
/** Test seam (virtual time); production uses the real clock. */
export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }
const realClock: Clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

export const WAIT_FOR = {
  type: 'function',
  function: {
    name: 'wait_for',
    description:
      'Wait for an async job WITHOUT spending ' +
      'steps: the harness GETs `url` every `every_s` seconds until the JSON value at `until.field` is one of `until.in` (case-insensitive), ' +
      'then GETs `then` (if given) and returns that body. Without `until`, it polls until `url` stops answering HTTP 202 (following ' +
      'Location / Retry-After). Use it right after a submit returns status_url/response_url or HTTP 202. Polls are normal calls: ' +
      'paid ones are charged and checked like http. Failed statuses (FAILED, ERROR, CANCELLED…) and timeouts end the wait early.',
    parameters: {
      type: 'object',
      required: ['url', 'reason'],
      properties: {
        url: { type: 'string', description: 'status URL to poll (GET)' },
        method: { type: 'string', enum: ['GET'] },
        until: {
          type: 'object',
          required: ['field', 'in'],
          description:
            'done when this JSON field (dot path, e.g. "status" or "data.state") has one of these values',
          properties: {
            field: { type: 'string' },
            in: { type: 'array', items: { type: 'string' } },
          },
        },
        then: {
          type: 'string',
          description: 'optional: URL to GET once done (e.g. response_url); its body is returned',
        },
        every_s: {
          type: 'number',
          description: `seconds between polls (default ${config.jobs.everyS[2]}, ${config.jobs.everyS[0]}–${config.jobs.everyS[1]})`,
        },
        timeout_s: {
          type: 'number',
          description: `give up after this many seconds (default ${config.jobs.timeoutS[2]}, max ${config.jobs.timeoutS[1]})`,
        },
        reason: { type: 'string', description: 'one-line why, shown to the user' },
      },
    },
  },
}

type Args = {
  url?: unknown
  method?: unknown
  until?: { field?: unknown; in?: unknown }
  then?: unknown
  every_s?: unknown
  timeout_s?: unknown
  reason?: unknown
}
const clamp = (v: unknown, [min, max, d]: [number, number, number]) => {
  const n = Number(v)
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(max, Math.max(min, n)) : d
}
const isHttpUrl = (u: unknown): u is string =>
  typeof u === 'string' && URL.canParse(u) && /^https?:$/.test(new URL(u).protocol)
const FAILED =
  /^(fail(ed|ure)?|error(ed)?|cancell?ed|expired|rejected|timed?_?out|aborted|not_found)$/i
const FATAL_HTTP = new Set([400, 401, 403, 405, 410]) // the status URL itself is wrong: retrying won't help
const MAX_ERRORS = 3 // consecutive transient poll errors (404 right after submit, 429, 5xx, network) before giving up

/** The value at a dot path ("status", "data.state", "jobs.0.status"), or undefined. */
export function pick(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<any>((v, k) => (v != null && typeof v === 'object' ? v[k] : undefined), body)
}
const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const asStr = (v: unknown) =>
  v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v)

/** Parsed, clamped wait_for arguments, or an error string for the model. */
export function planWait(args: Args, runPolls: number, jobs = config.jobs) {
  if (!isHttpUrl(args.url))
    return { error: 'wait_for rejected: "url" must be a full https:// URL. No charge.' }
  if (args.method !== undefined && String(args.method).toUpperCase() !== 'GET')
    return { error: 'wait_for rejected: polls are GET only. No charge.' }
  if (args.then !== undefined && args.then !== null && args.then !== '' && !isHttpUrl(args.then))
    return { error: 'wait_for rejected: "then" must be a full https:// URL. No charge.' }
  let until: { field: string; in: string[] } | undefined
  if (args.until != null) {
    const f = args.until.field,
      vals = args.until.in
    if (typeof f !== 'string' || !f.trim() || !Array.isArray(vals) || !vals.length)
      return {
        error:
          'wait_for rejected: "until" needs a "field" (dot path) and a non-empty "in" array. No charge.',
      }
    until = { field: f.trim(), in: vals.map((v) => String(v)) } // shown as given; compared case-insensitively
  }
  const maxPolls = pollsAllowed(runPolls, jobs)
  if (maxPolls <= 0)
    return {
      error: `wait_for rejected: this run has used its ${jobs.maxPollsPerRun} polls (run-level cap). No charge.`,
    }
  return {
    url: args.url,
    then: isHttpUrl(args.then) ? args.then : undefined,
    until,
    maxPolls,
    everyS: clamp(args.every_s, jobs.everyS),
    timeoutS: clamp(args.timeout_s, jobs.timeoutS),
    reason: String(args.reason ?? ''),
  }
}

/** Retry-After as seconds (delta or HTTP date), or undefined. */
function retryAfterS(h: string | undefined, now: number): number | undefined {
  if (!h) return undefined
  if (/^\d+(\.\d+)?$/.test(h.trim())) return Number(h)
  const t = Date.parse(h)
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : undefined
}

/**
 * Poll until done, failed, timed out, stopped, blocked or out of polls. Returns the tool result for the model:
 * a receipt line, a one-line outcome, then the final body through forLlm.
 */
export async function waitFor(
  run: Run,
  step: number,
  args: Args,
  fetcher: Fetcher,
  clock: Clock = realClock,
): Promise<string> {
  const top = run.parent ?? run
  const plan = planWait(args, top.polls)
  if ('error' in plan) return plan.error!
  const { then, until, maxPolls, everyS, timeoutS, reason } = plan
  let url = plan.url
  const jobId = `job-${++top.jobs}`,
    callId = top.jobUrls.get(url) ?? (then ? top.jobUrls.get(then) : undefined)
  const t0 = clock.now(),
    stopped = () => run.stopRequested || !!run.parent?.stopRequested
  let polls = 0,
    paidPolls = 0,
    spentUsd = 0,
    errors = 0,
    status: string | undefined,
    last: CallResult | undefined,
    seenField = false
  const progress = () => ({
    jobId,
    ...(callId ? { callId } : {}),
    url,
    ...(then ? { then } : {}),
    polls,
    paidPolls,
    spentUsd,
    elapsedMs: clock.now() - t0,
    ...(status !== undefined ? { status } : {}),
  })
  const charge = (r: CallResult) => {
    if (r.status === 'paid' || r.status === 'paid_failed') spentUsd += r.costUsd ?? 0
  }
  emit(run, 'job.waiting', {
    ...progress(),
    every_s: everyS,
    timeout_s: timeoutS,
    reason,
    ...(until ? { until } : {}),
  })

  const end = (outcome: JobOutcome, message: string, body?: CallResult, resultCallId?: string) => {
    emit(run, 'job.finished', {
      ...progress(),
      outcome,
      message,
      ...(resultCallId ? { resultCallId } : {}),
    })
    const secs = Math.round((clock.now() - t0) / 1000)
    const head =
      `[job ${outcome} · ${polls} poll${polls === 1 ? '' : 's'} over ${secs}s · ${paidPolls} paid poll${paidPolls === 1 ? '' : 's'}` +
      ` · job spend ${usd(spentUsd)} · ${budgetLine(run)}]`
    return `${head}\n${message}${body ? `\nHTTP ${body.httpStatus}\n${forLlm(body.text)}` : ''}`
  }

  // Sleep in short slices so a stop request (or the deadline) interrupts the wait without waiting out the interval.
  const nap = async (ms: number) => {
    for (const until = clock.now() + ms; clock.now() < until && !stopped();)
      await clock.sleep(Math.min(250, until - clock.now()))
  }

  while (true) {
    if (stopped())
      return end('stopped', 'Stopped by user while waiting; the job may still be running.', last)
    if (polls >= maxPolls)
      return end(
        'poll_cap',
        `Gave up after ${polls} polls (cap: ${maxPolls} for this wait, ${config.jobs.maxPollsPerRun} per run); ` +
          `last status ${status ?? 'unknown'}. The job may still finish: one more wait_for later is possible if budget allows.`,
        last,
      )
    polls++
    top.polls++
    const r = await fetcher(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(config.callTimeoutMs),
      },
      {
        step,
        kind: 'http',
        reason: `poll ${polls}${reason ? `: ${reason}` : ''}`,
        job: { jobId, poll: polls, role: 'poll' },
      },
    )
    last = r
    if (r.status === 'paid' || r.status === 'paid_failed') paidPolls++
    charge(r)
    if (r.status === 'blocked')
      return end(
        'blocked',
        `A poll was blocked before paying: ${r.reason ?? 'policy'}. No charge for that poll.`,
        r,
      )

    let done = false
    const ok = r.httpStatus >= 200 && r.httpStatus < 300
    if (!ok) {
      status = `HTTP ${r.httpStatus || 'error'}`
      if (FATAL_HTTP.has(r.httpStatus) || ++errors >= MAX_ERRORS)
        return end(
          'failed',
          `Polling ${url} failed (${r.reason ?? `HTTP ${r.httpStatus}`}${errors > 1 ? `, ${errors} times in a row` : ''}).`,
          r,
        )
    } else if (until) {
      errors = 0
      const v = pick(json(r.text), until.field)
      if (v !== undefined) seenField = true
      status = v === undefined ? `(no "${until.field}")` : asStr(v)
      if (v !== undefined && until.in.some((x) => x.toLowerCase() === String(v).toLowerCase()))
        done = true
      else if (typeof v === 'string' && FAILED.test(v))
        return end('failed', `The job reported ${until.field}=${v}.`, r)
    } else {
      errors = 0
      if (r.httpStatus === 202) {
        status = 'HTTP 202'
        if (r.location && URL.canParse(r.location, url)) url = new URL(r.location, url).href
      } else {
        status = `HTTP ${r.httpStatus}`
        done = true
      }
    }
    emit(run, 'job.waiting', {
      ...progress(),
      every_s: everyS,
      timeout_s: timeoutS,
      reason,
      ...(until ? { until } : {}),
    })

    if (done) {
      if (!then)
        return end(
          'completed',
          `Done: ${until ? `${until.field}=${status}` : status} after ${polls} poll${polls === 1 ? '' : 's'}.`,
          r,
        )
      const res = await fetcher(
        then,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(config.callTimeoutMs),
        },
        {
          step,
          kind: 'http',
          reason: `result${reason ? `: ${reason}` : ''}`,
          job: { jobId, role: 'result' },
        },
      )
      charge(res)
      if (res.status === 'blocked')
        return end(
          'blocked',
          `The job finished, but fetching the result was blocked: ${res.reason ?? 'policy'}.`,
          res,
          res.callId,
        )
      if (res.httpStatus < 200 || res.httpStatus >= 300)
        return end(
          'failed',
          `The job reported ${status}, but GET ${then} returned HTTP ${res.httpStatus || 'error'}.`,
          res,
          res.callId,
        )
      return end(
        'completed',
        `Done: ${until ? `${until.field}=${status}` : status} after ${polls} poll${polls === 1 ? '' : 's'}; result from ${then}:`,
        res,
        res.callId,
      )
    }
    const wait = until
      ? everyS
      : Math.min(
          config.jobs.everyS[1],
          Math.max(config.jobs.everyS[0], retryAfterS(r.retryAfter, clock.now()) ?? everyS),
        )
    if ((clock.now() - t0) / 1000 + wait > timeoutS)
      return end(
        'timeout',
        `Timed out after ${Math.round((clock.now() - t0) / 1000)}s (timeout_s ${timeoutS}); last status ${status ?? 'unknown'}.` +
          (until && !seenField
            ? ` The field "${until.field}" never appeared: check the path against the body below.`
            : ' The job may still finish.'),
        last,
      )
    await nap(wait * 1000)
  }
}

// ---------------------------------------------------------------- nudges in the http tool result
const STATUS_KEYS = ['status_url', 'statusUrl', 'poll_url', 'pollUrl', 'polling_url', 'pollingUrl']
const RESULT_KEYS = ['response_url', 'responseUrl', 'result_url', 'resultUrl']
const DONE_VALUES = ['COMPLETED', 'SUCCEEDED', 'SUCCESS', 'DONE']

/** First string under any of `keys`, at the top level or one object down (e.g. {data:{status_url}}, {urls:{get}}). */
function findUrl(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const o of [
    body,
    ...Object.values(body).filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v),
    ),
  ])
    for (const k of keys) if (typeof o[k] === 'string') return o[k] as string
}

/**
 * A short note for the model when a response looks like an async job (status_url/response_url, HTTP 202), or a
 * problem+json tells it to resubmit elsewhere and poll. Records status URLs → callId so the UI can tie the wait to
 * its submit. Generic: only the common field names are special.
 */
export function jobNudge(run: Run, r: CallResult, requestUrl: string): string {
  const top = run.parent ?? run,
    body = json(r.text)
  const abs = (u: string | undefined) =>
    !u
      ? undefined
      : URL.canParse(u)
        ? new URL(u).href
        : URL.canParse(u, requestUrl)
          ? new URL(u, requestUrl).href
          : undefined
  const remember = (u: string | undefined) => {
    if (u && r.callId) top.jobUrls.set(u, r.callId)
  }
  const o =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  const ok = r.httpStatus >= 200 && r.httpStatus < 300
  if (o && ok) {
    const statusUrl =
      abs(findUrl(o, STATUS_KEYS)) ??
      abs(typeof (o.urls as any)?.get === 'string' ? (o.urls as any).get : undefined)
    const resultUrl = abs(findUrl(o, RESULT_KEYS))
    if (statusUrl) {
      remember(statusUrl)
      remember(resultUrl)
      const field = 'status' in o ? 'status' : 'state' in o ? 'state' : 'status'
      const args = {
        url: statusUrl,
        until: { field, in: DONE_VALUES },
        ...(resultUrl ? { then: resultUrl } : {}),
        reason: 'wait for the job',
      }
      return (
        `\n\n[harness] This is an async job${o[field] !== undefined ? ` (${field}: ${asStr(o[field])})` : ''}. Do not poll with http: ` +
        `call wait_for, which polls in code without spending steps, e.g. wait_for ${JSON.stringify(args)}`
      )
    }
    if (resultUrl && r.httpStatus === 202) remember(resultUrl)
  }
  if (r.httpStatus === 202) {
    const target = abs(r.location) ?? requestUrl
    remember(target)
    return (
      `\n\n[harness] HTTP 202 Accepted: the work continues in the background. Call wait_for ${JSON.stringify({ url: target, reason: 'wait for the job' })} ` +
      `(no "until") to poll until it stops answering 202${r.retryAfter ? ` (server suggests Retry-After ${r.retryAfter})` : ''}.`
    )
  }
  if (o && r.httpStatus >= 400 && r.httpStatus < 500) {
    const detail = [o.detail, o.message, o.title, (o.error as any)?.message, o.error].find(
      (v): v is string => typeof v === 'string' && /poll|queue|async/i.test(v),
    )
    const other = detail?.match(/https?:\/\/[^\s"'<>]+[^\s"'<>.,;:)]/)?.[0]
    if (detail && other && other !== requestUrl)
      return (
        `\n\n[harness] The server says to use its async queue: send the same request (same method and body) to ${other}. ` +
        'It should answer with a status_url (and response_url): then call wait_for instead of polling with http.'
      )
  }
  return ''
}
