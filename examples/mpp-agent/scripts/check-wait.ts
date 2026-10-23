// Offline checks for wait_for and the async-job nudges: `pnpm exec tsx scripts/check-wait.ts`.
// No wallet, no keys, no paid calls: a mock server on 127.0.0.1 plays the job API, and the polling core
// (src/jobs.ts) is driven with a test fetcher passed as a function argument. Production always passes paidFetch
// (src/agent.ts), so the host blocklist, which rightly blocks 127.0.0.1, is not bypassable from config or env.
// Time is virtual (the Clock argument), so the timeout and the 60-poll cap run in well under a second.
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { config } from '../src/config.ts'
import { createRun, emit, runs, truncate, type Run } from '../src/events.ts'
import { jobNudge, planWait, waitFor, type Clock, type Fetcher } from '../src/jobs.ts'
import type { CallResult } from '../src/paidFetch.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------- mock job server
const hits = new Map<string, number>() // path → GETs so far
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }
const seq =
  (...states: string[]) =>
  (n: number): Reply => {
    const s = states[Math.min(n, states.length) - 1]
    return { status: s === 'COMPLETED' ? 200 : 202, body: { status: s } }
  }
const routes: Record<string, (n: number) => Reply> = {
  '/q/ok/status': seq('IN_QUEUE', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'),
  '/q/ok': () => ({ body: { video: { url: 'https://example.com/fox.mp4' } } }),
  '/q/fail/status': seq('IN_PROGRESS', 'FAILED'),
  '/q/slow/status': () => ({ status: 202, body: { status: 'IN_PROGRESS' } }),
  '/q/nested/status': (n) => ({ body: { data: { state: n >= 2 ? 'done' : 'running' } } }),
  '/q/flaky/status': (n) =>
    n <= 2 ? { status: 404, body: { status: 'NOT_FOUND' } } : { body: { status: 'COMPLETED' } },
  '/q/auth/status': () => ({ status: 401, body: { error: 'unauthorized' } }),
  '/op/1': () => ({
    status: 202,
    headers: { location: '/op/1/next', 'retry-after': '3' },
    body: { accepted: true },
  }),
  '/op/1/next': (n) =>
    n <= 2
      ? { status: 202, headers: { 'retry-after': '1' } }
      : { body: { done: true, answer: 42 } },
}
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname,
    n = (hits.get(path) ?? 0) + 1
  hits.set(path, n)
  const r = routes[path]?.(n) ?? { status: 404, body: { error: 'no route' } }
  res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers })
  res.end(r.body === undefined ? '' : JSON.stringify(r.body))
})
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

// ---------------------------------------------------------------- test fetcher + virtual clock
/** Mimics paidFetch's events and CallResult. `paid` paths are reported as paid at $0.001; `blocked` paths as blocked. */
function mockFetcher(
  run: Run,
  opts: { paid?: string[]; blocked?: string[]; after?: (poll: number) => void } = {},
): Fetcher {
  return async (url, init, ctx) => {
    const top = run.parent ?? run,
      callId = String(++top.calls),
      host = new URL(url).host,
      path = new URL(url).pathname
    emit(run, 'call.started', {
      callId,
      step: ctx.step,
      kind: ctx.kind,
      method: 'GET',
      url,
      host,
      reason: ctx.reason,
      requestExcerpt: '',
      ...ctx.job,
    })
    let r: CallResult
    if (opts.blocked?.includes(path))
      r = {
        callId,
        status: 'blocked',
        httpStatus: 402,
        host,
        text: 'blocked by policy: test',
        reason: 'test block',
      }
    else {
      const res = await fetch(url, init)
      const text = await res.text(),
        paid = opts.paid?.includes(path)
      if (paid)
        emit(run, 'call.paid', { callId, chargedUsd: 0.001, txHashes: [], explorerUrls: [] })
      r = {
        callId,
        status: paid ? (res.ok ? 'paid' : 'paid_failed') : res.status >= 400 ? 'failed' : 'free',
        httpStatus: res.status,
        host,
        text,
        ...(paid ? { costUsd: 0.001 } : {}),
        location: res.headers.get('location') ?? undefined,
        retryAfter: res.headers.get('retry-after') ?? undefined,
      }
    }
    emit(run, 'call.finished', {
      callId,
      status: r.status,
      httpStatus: r.httpStatus,
      latencyMs: 1,
      responseBytes: r.text.length,
      responseExcerpt: truncate(r.text, 1500),
    })
    if (ctx.job.role === 'poll') opts.after?.(ctx.job.poll!)
    return r
  }
}
function virtualClock(): Clock & { slept: number[] } {
  let t = 1_000_000
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      t += ms
      slept.push(ms)
      await new Promise((r) => setImmediate(r))
    },
  }
}
const made: string[] = []
const newRun = () => {
  const r = createRun('check-wait', false, {
    totalUsd: 1,
    inferenceUsd: 0.5,
    toolsUsd: 0.5,
    perCallUsd: 0.1,
  })
  made.push(r.id)
  return r
}
const evs = (run: Run, type: string) => run.events.filter((e) => e.type === type) as any[]

// ---------------------------------------------------------------- planWait
{
  const p = planWait(
    { url: 'https://a.example/s', every_s: 0.1, timeout_s: 99999, reason: 'x' },
    0,
  ) as any
  check('clamps every_s to the minimum', p.everyS === config.jobs.everyS[0], String(p.everyS))
  check(
    'clamps timeout_s to the maximum',
    p.timeoutS === config.jobs.timeoutS[1],
    String(p.timeoutS),
  )
  const d = planWait({ url: 'https://a.example/s' }, 0) as any
  check(
    'defaults every_s/timeout_s',
    d.everyS === 5 && d.timeoutS === 300 && d.maxPolls === config.jobs.maxPollsPerWait,
  )
  check('rejects a non-URL', 'error' in planWait({ url: 'status_url' }, 0))
  check(
    'rejects non-GET polls',
    'error' in planWait({ url: 'https://a.example/s', method: 'POST' }, 0),
  )
  check(
    'rejects a bad then',
    'error' in planWait({ url: 'https://a.example/s', then: 'response_url' }, 0),
  )
  check(
    'rejects until without values',
    'error' in planWait({ url: 'https://a.example/s', until: { field: 'status', in: [] } }, 0),
  )
  check(
    'run-level poll cap shrinks a wait',
    (planWait({ url: 'https://a.example/s' }, config.jobs.maxPollsPerRun - 3) as any).maxPolls ===
      3,
  )
  check(
    'run-level poll cap rejects when spent',
    'error' in planWait({ url: 'https://a.example/s' }, config.jobs.maxPollsPerRun),
  )
}

// ---------------------------------------------------------------- nudges
{
  const run = newRun()
  const submit = {
    request_id: 'abc',
    status: 'IN_QUEUE',
    status_url: `${base}/q/ok/status`,
    response_url: `${base}/q/ok`,
  }
  const n = jobNudge(
    run,
    { callId: '7', status: 'paid', httpStatus: 200, host: 'x', text: JSON.stringify(submit) },
    `${base}/q/submit`,
  )
  check(
    'nudge: status_url → wait_for with args',
    n.includes('wait_for') &&
      n.includes(`"url":"${base}/q/ok/status"`) &&
      n.includes(`"then":"${base}/q/ok"`) &&
      n.includes('"field":"status"'),
  )
  check('nudge: remembers the submit callId', run.jobUrls.get(`${base}/q/ok/status`) === '7')
  const n202 = jobNudge(
    run,
    {
      callId: '8',
      status: 'free',
      httpStatus: 202,
      host: 'x',
      text: '',
      location: '/op/1/next',
      retryAfter: '3',
    },
    `${base}/op/1`,
  )
  check(
    'nudge: 202 + Location → wait_for without until',
    n202.includes(`"url":"${base}/op/1/next"`) &&
      !n202.includes('"until":') &&
      n202.includes('Retry-After 3'),
  )
  const fal = {
    type: 'https://paymentauth.org/problems/bad-request',
    title: 'Bad Request',
    status: 400,
    detail:
      'Video generation can exceed the synchronous timeout. Submit it to https://fal-queue.mpp.tempo.xyz/minimax/h3-max/text-to-video and poll the returned status_url.',
  }
  const n400 = jobNudge(
    run,
    { status: 'failed', httpStatus: 400, host: 'fal.mpp.tempo.xyz', text: JSON.stringify(fal) },
    'https://fal.mpp.tempo.xyz/minimax/h3-max/text-to-video',
  )
  check(
    'nudge: problem+json "submit to … and poll" surfaced',
    n400.includes(
      '(same method and body) to https://fal-queue.mpp.tempo.xyz/minimax/h3-max/text-to-video. ',
    ) && n400.includes('wait_for'),
    n400.trim(),
  )
  check(
    'nudge: none on a plain 200',
    jobNudge(
      run,
      { status: 'free', httpStatus: 200, host: 'x', text: '{"ok":true}' },
      `${base}/x`,
    ) === '',
  )
  const rep = jobNudge(
    run,
    {
      callId: '9',
      status: 'paid',
      httpStatus: 201,
      host: 'x',
      text: JSON.stringify({ id: 'p1', status: 'starting', urls: { get: `${base}/r/p1` } }),
    },
    `${base}/r`,
  )
  check('nudge: urls.get (Replicate-style) recognised', rep.includes(`"url":"${base}/r/p1"`))
}

// ---------------------------------------------------------------- waitFor scenarios
{
  // queue: IN_QUEUE → IN_PROGRESS → COMPLETED, then GET response_url
  const run = newRun(),
    clock = virtualClock()
  run.jobUrls.set(`${base}/q/ok/status`, '7')
  const out = await waitFor(
    run,
    3,
    {
      url: `${base}/q/ok/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      then: `${base}/q/ok`,
      every_s: 5,
      reason: 'wait for video',
    },
    mockFetcher(run),
    clock,
  )
  const fin = evs(run, 'job.finished')[0],
    waits = evs(run, 'job.waiting'),
    starts = evs(run, 'call.started')
  check('queue: completed', fin?.outcome === 'completed', fin?.message)
  check(
    'queue: 4 polls, waited 3 intervals',
    fin?.polls === 4 && clock.slept.reduce((a, b) => a + b, 0) === 15_000,
    `${fin?.polls} polls, slept ${clock.slept.reduce((a, b) => a + b, 0)}ms`,
  )
  check(
    'queue: result body returned to the model',
    out.includes('fox.mp4') && out.startsWith('[job completed · 4 polls over 15s'),
  )
  check(
    'queue: job.waiting at start + after every poll',
    waits.length === 5 && waits[0].polls === 0 && waits[4].status === 'COMPLETED',
  )
  check('queue: tied to submit call', fin?.callId === '7' && waits[0].callId === '7')
  check(
    'queue: polls and result tagged',
    starts.filter((e) => e.role === 'poll').length === 4 &&
      starts.filter((e) => e.role === 'result').length === 1 &&
      starts.every((e) => e.jobId === fin?.jobId),
  )
  check(
    'queue: resultCallId set',
    fin?.resultCallId === starts.find((e) => e.role === 'result')?.callId,
  )
  check('queue: run poll counter', run.polls === 4 && run.jobs === 1)
}
{
  // FAILED terminal
  const run = newRun()
  const out = await waitFor(
    run,
    1,
    {
      url: `${base}/q/fail/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      then: `${base}/q/ok`,
    },
    mockFetcher(run),
    virtualClock(),
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'failed: terminal status ends the wait',
    fin?.outcome === 'failed' && fin.polls === 2 && out.includes('status=FAILED'),
    fin?.message,
  )
  check('failed: then not fetched', !evs(run, 'call.started').some((e) => e.role === 'result'))
}
{
  // timeout
  const run = newRun(),
    clock = virtualClock()
  const out = await waitFor(
    run,
    1,
    {
      url: `${base}/q/slow/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      every_s: 2,
      timeout_s: 10,
    },
    mockFetcher(run),
    clock,
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'timeout: ends with timeout',
    fin?.outcome === 'timeout' && out.includes('Timed out'),
    `${fin?.polls} polls, ${fin?.elapsedMs}ms`,
  )
  check(
    'timeout: never past timeout_s (polls at 0,2,…,10s)',
    fin?.elapsedMs <= 10_000 && fin.polls === 6,
  )
}
{
  // field path never present → timeout explains it
  const run = newRun()
  const out = await waitFor(
    run,
    1,
    {
      url: `${base}/q/slow/status`,
      until: { field: 'state', in: ['done'] },
      every_s: 2,
      timeout_s: 10,
    },
    mockFetcher(run),
    virtualClock(),
  )
  check('timeout: missing field is called out', out.includes('"state" never appeared'))
}
{
  // nested dot path, lowercase values
  const run = newRun()
  await waitFor(
    run,
    1,
    { url: `${base}/q/nested/status`, until: { field: 'data.state', in: ['DONE'] } },
    mockFetcher(run),
    virtualClock(),
  )
  check(
    'dot path + case-insensitive match',
    evs(run, 'job.finished')[0]?.outcome === 'completed' && evs(run, 'job.finished')[0].polls === 2,
  )
}
{
  // 202 + Location + Retry-After
  const run = newRun(),
    clock = virtualClock()
  const out = await waitFor(run, 1, { url: `${base}/op/1` }, mockFetcher(run), clock)
  const fin = evs(run, 'job.finished')[0],
    urls = evs(run, 'call.started').map((e) => new URL(e.url).pathname)
  check(
    '202: completed when no longer 202',
    fin?.outcome === 'completed' && out.includes('"answer": 42'),
    fin?.message,
  )
  check(
    '202: follows Location',
    urls.join(',') === '/op/1,/op/1/next,/op/1/next,/op/1/next',
    urls.join(','),
  )
  check(
    '202: honours Retry-After (clamped to the 2s minimum)',
    clock.slept.reduce((a, b) => a + b, 0) === 3000 + 2000 + 2000,
    clock.slept.join(','),
  )
}
{
  // per-wait poll cap
  const run = newRun()
  const out = await waitFor(
    run,
    1,
    {
      url: `${base}/q/slow/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      every_s: 2,
      timeout_s: 900,
    },
    mockFetcher(run),
    virtualClock(),
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'poll cap: stops at maxPollsPerWait',
    fin?.outcome === 'poll_cap' &&
      fin.polls === config.jobs.maxPollsPerWait &&
      out.includes('Gave up after 60 polls'),
    `${fin?.polls}`,
  )
}
{
  // run-level poll cap, shared with a sub-agent
  const run = newRun()
  run.polls = config.jobs.maxPollsPerRun - 2
  const child = createRun('child', false, run.budget, { parent: run, label: 'sub' })
  await waitFor(
    child,
    1,
    {
      url: `${base}/q/slow/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      every_s: 2,
      timeout_s: 900,
    },
    mockFetcher(child),
    virtualClock(),
  )
  check(
    'run poll cap: a sub-agent draws on the parent count',
    run.polls === config.jobs.maxPollsPerRun && evs(child, 'job.finished')[0]?.polls === 2,
  )
  const again = await waitFor(
    child,
    2,
    { url: `${base}/q/slow/status` },
    mockFetcher(child),
    virtualClock(),
  )
  check(
    'run poll cap: further waits rejected, no polls sent',
    again.startsWith('wait_for rejected') && run.polls === config.jobs.maxPollsPerRun,
  )
  check(
    'sub-agent job events land in the parent log',
    run.events.some((e) => e.type === 'job.finished' && (e as any).agent === 'sub'),
  )
}
{
  // stop signal between polls
  const run = newRun()
  await waitFor(
    run,
    1,
    { url: `${base}/q/slow/status`, until: { field: 'status', in: ['COMPLETED'] } },
    mockFetcher(run, {
      after: (p) => {
        if (p === 2) run.stopRequested = true
      },
    }),
    virtualClock(),
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'stop: ends the wait after the current poll',
    fin?.outcome === 'stopped' && fin.polls === 2,
    `${fin?.polls}`,
  )
}
{
  // stop during a long sleep: interrupted, not waited out
  const run = newRun(),
    clock = virtualClock(),
    realSleep = clock.sleep
  clock.sleep = async (ms) => {
    await realSleep(ms)
    if (clock.slept.length === 3) run.stopRequested = true
  }
  await waitFor(
    run,
    1,
    { url: `${base}/q/slow/status`, until: { field: 'status', in: ['COMPLETED'] }, every_s: 60 },
    mockFetcher(run),
    clock,
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'stop: interrupts the sleep within 250ms slices',
    fin?.outcome === 'stopped' && fin.polls === 1 && fin.elapsedMs === 750,
    `${fin?.elapsedMs}ms`,
  )
}
{
  // paid polls are counted; a blocked poll ends the wait
  hits.delete('/q/ok/status')
  const run = newRun()
  const out = await waitFor(
    run,
    1,
    {
      url: `${base}/q/ok/status`,
      until: { field: 'status', in: ['COMPLETED'] },
      then: `${base}/q/ok`,
    },
    mockFetcher(run, { paid: ['/q/ok/status', '/q/ok'] }),
    virtualClock(),
  )
  const fin = evs(run, 'job.finished')[0]
  check(
    'paid polls: counted and summed',
    fin?.paidPolls === 4 &&
      Math.abs(fin.spentUsd - 0.005) < 1e-9 &&
      out.includes('4 paid polls · job spend $0.0050'),
    `${fin?.paidPolls}, ${fin?.spentUsd}`,
  )
  hits.delete('/q/ok/status')
  const run2 = newRun()
  const out2 = await waitFor(
    run2,
    1,
    { url: `${base}/q/ok/status`, until: { field: 'status', in: ['COMPLETED'] } },
    mockFetcher(run2, { blocked: ['/q/ok/status'] }),
    virtualClock(),
  )
  check(
    'blocked poll: ends the wait',
    evs(run2, 'job.finished')[0]?.outcome === 'blocked' && out2.includes('blocked before paying'),
  )
}
{
  // transient 404s are retried; 401 fails at once
  const run = newRun()
  await waitFor(
    run,
    1,
    { url: `${base}/q/flaky/status`, until: { field: 'status', in: ['COMPLETED'] } },
    mockFetcher(run),
    virtualClock(),
  )
  check(
    'transient 404 then completed',
    evs(run, 'job.finished')[0]?.outcome === 'completed' && evs(run, 'job.finished')[0].polls === 3,
  )
  const run2 = newRun()
  await waitFor(
    run2,
    1,
    { url: `${base}/q/auth/status`, until: { field: 'status', in: ['COMPLETED'] } },
    mockFetcher(run2),
    virtualClock(),
  )
  check(
    '401 fails on the first poll',
    evs(run2, 'job.finished')[0]?.outcome === 'failed' && evs(run2, 'job.finished')[0].polls === 1,
  )
}

server.close()
for (const id of made) {
  rmSync(`runs/${id}.jsonl`, { force: true })
  runs.delete(id)
} // only the logs this check wrote
console.log(failed ? `${failed} FAILED` : 'all wait_for checks passed')
process.exit(failed ? 1 : 0)
