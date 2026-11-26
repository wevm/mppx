import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname } from 'node:path'

import { runAgent } from './agent.ts'
import { config } from './config.ts'
import { createRun, emit, runs, type Event } from './events.ts'
import { indexDoc, parseEvents, runDoc, summarizeRun, type RunMeta } from './runview.ts'
import { verifyRun, verifyWallet } from './verify.ts'
import {
  accessKey,
  balanceUsd,
  initialKeyState,
  keyAddress,
  mode,
  walletAddress,
  walletNote,
  walletSnapshot,
} from './wallet.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}
// Generated media (images, video, audio) is hosted by the providers, so allow https media; scripts stay 'self'-only.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'"
// The site/ front end, shared with the static Pages export. Live mode is marked on <body data-mode="live">.
const PAGES: Record<string, string> = {
  '/loop.svg': 'site/loop.svg',
  '/': 'site/try.html',
  '/try.html': 'site/try.html',
  '/index.html': 'site/index.html',
  '/run.html': 'site/run.html',
  '/how.html': 'site/how.html',
  '/site.js': 'site/site.js',
  '/site.css': 'site/site.css',
  '/SKILL.md': 'SKILL.md',
}
let active: string | null = null

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-security-policy': CSP,
    'cache-control': 'no-store',
  })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
const readBody = async (req: IncomingMessage) => {
  let s = ''
  for await (const c of req) s += c
  return s
}
const loadEvents = (id: string): Event[] =>
  runs.get(id)?.events ??
  (/^[\w-]+$/.test(id) && existsSync(`runs/${id}.jsonl`)
    ? parseEvents(readFileSync(`runs/${id}.jsonl`, 'utf8'))
    : [])
const runIds = () =>
  readdirSync('runs')
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -6))
    .sort()
    .reverse()
/** Titles and emoji for curated runs come from site.config.json, same as the static export. */
const runMeta = (): Record<string, RunMeta> => {
  try {
    return Object.fromEntries(
      (JSON.parse(readFileSync('site.config.json', 'utf8')).runs ?? []).map(
        (r: RunMeta & { id: string }) => [r.id, r],
      ),
    )
  } catch {
    return {}
  }
}
const shape = (id: string, meta = runMeta()) =>
  summarizeRun(id, loadEvents(id), meta[id], { active: id === active })

async function handle(req: IncomingMessage, res: ServerResponse) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  const [, api, a, b, c, d] = pathname.split('/')
  if (api !== 'api') {
    // the site/ front end (whitelisted files only)
    const file = PAGES[pathname]
    if (!file || !existsSync(file)) return send(res, 404, { error: 'not found' })
    const body = readFileSync(file, 'utf8')
    return send(
      res,
      200,
      file.endsWith('.html')
        ? body.replace(/<body data-page="(\w+)">/, '<body data-page="$1" data-mode="live">')
        : body,
      TYPES[extname(file)] ?? 'text/plain',
    )
  }
  // Same shapes as the static export's data/index.json and data/runs/<id>.json (see src/runview.ts).
  if (a === 'site' && b === 'index') {
    // History lists the curated runs (the same set as the static site) plus whatever run is in progress.
    const meta = runMeta(),
      rows = runIds()
        .filter((id) => id in meta || id === active)
        .map((id) => shape(id, meta))
        .filter((r) => r.summary.startedAt)
    return send(res, 200, { ...indexDoc('mpp-agent', rows), activeRunId: active })
  }
  if (a === 'site' && b === 'runs' && c && !d) {
    const evs = loadEvents(c)
    return evs.length
      ? send(res, 200, runDoc(shape(c).summary, evs))
      : send(res, 404, { error: 'no such run' })
  }
  if (a === 'wallet')
    return send(res, 200, {
      address: walletAddress,
      mode,
      ...(mode === 'tempo-wallet' ? { accessKey: keyAddress } : {}),
      ...(await walletSnapshot()),
      network: config.network,
      token: config.token,
      symbol: config.symbol,
      activeRunId: active,
    })
  if (a === 'runs' && !b && req.method === 'POST') {
    if (active) return send(res, 409, { error: 'a run is already active', runId: active })
    const input = JSON.parse((await readBody(req)) || '{}')
    const task = String(input.task ?? '').trim(),
      hints = input.hints !== false // tool map on by default
    const subagents = input.subagents === true // spawn tool off by default
    if (!task) return send(res, 400, { error: 'task required' })
    // A run may carry its own allocation, but only ever tighter than the server defaults.
    const asked = (input.budget ?? {}) as Record<string, unknown>
    const budget = Object.fromEntries(
      Object.entries(config.budget).map(([k, v]) => [
        k,
        typeof asked[k] === 'number' && (asked[k] as number) > 0
          ? Math.min(v, asked[k] as number)
          : v,
      ]),
    ) as typeof config.budget
    const run = createRun(task, hints, budget)
    run.subagentsAllowed = subagents
    active = run.id
    emit(run, 'run.started', {
      task,
      hints,
      subagents,
      model: config.model,
      network: config.network,
      budget: run.budget,
      wallet: {
        address: walletAddress,
        mode,
        ...(mode === 'tempo-wallet' ? { accessKey: keyAddress } : {}),
        ...(await walletSnapshot()),
      },
    })
    runAgent(run).finally(() => {
      active = null
    })
    return send(res, 200, { runId: run.id })
  }
  if (a === 'runs' && c === 'verify') {
    const evs = loadEvents(b)
    return evs.length
      ? send(res, 200, await verifyRun(evs))
      : send(res, 404, { error: 'no such run' })
  }
  if (a === 'verify' && b === 'wallet')
    return send(res, 200, await verifyWallet(runIds().map(loadEvents)))
  if (a === 'runs' && c === 'stop' && req.method === 'POST') {
    const run = runs.get(b)
    if (!run) return send(res, 404, { error: 'no such run' })
    run.stopRequested = true
    return send(res, 200, { ok: true })
  }
  if (a === 'runs' && c === 'events') {
    // SSE: replay, then live
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const write = (e: Event) => res.write(`data: ${JSON.stringify(e)}\n\n`)
    loadEvents(b).forEach(write)
    const run = runs.get(b)
    if (run && !run.finished) {
      run.listeners.add(write)
      req.on('close', () => run.listeners.delete(write))
    }
    return
  }
  send(res, 404, { error: 'not found' })
}

/** One line on which wallet pays (addresses only), plus a nudge to move funds out of a local demo wallet. */
async function walletBanner() {
  const days = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (mode === 'tempo-wallet') {
    const w = await walletSnapshot()
    const left =
      w.allowanceUsd === undefined
        ? ''
        : ` · allowance $${w.allowanceUsd.toFixed(2)} of $${w.allowanceLimitUsd?.toFixed(2)}`
    const lines = [
      `wallet: Tempo Wallet ${walletAddress} via access key ${keyAddress}${left} · expires ${days(new Date(accessKey!.expiry * 1000).toISOString())}`,
    ]
    if (initialKeyState !== 'active')
      lines.push(
        initialKeyState === 'pending'
          ? 'The access key is approved but not registered on chain yet: the first payment registers it (one transaction your wallet pays for), or run `pnpm run setup -- --activate-only` now.'
          : "Couldn't read the access key's on-chain state; it will be checked before the first payment.",
      )
    return lines
  }
  const lines = [`wallet: local demo wallet ${walletAddress} (legacy mode)`]
  if (walletNote) lines.push(walletNote)
  const usd = await balanceUsd().catch(() => 0)
  if (usd >= config.dustUsd)
    lines.push(
      `Your funds ($${usd.toFixed(2)}) are in a local demo wallet; run \`pnpm run setup\` to move them to your Tempo Wallet.`,
    )
  return lines
}

createServer((req, res) =>
  handle(req, res).catch((err) => send(res, 500, { error: String(err?.message ?? err) })),
).listen(config.port, '127.0.0.1', async () => {
  console.log(
    `mpp-agent on http://127.0.0.1:${config.port} · ${config.network}${config.dryRun ? ' · DRY_RUN' : ''}`,
  )
  for (const line of await walletBanner().catch((e) => [`wallet: ${walletAddress} (${e.message})`]))
    console.log(`  ${line}`)
})
