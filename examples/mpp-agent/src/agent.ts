import { readFileSync } from 'node:fs'

import { config } from './config.ts'
import { budgetLine, createRun, emit, totals, usd, type FinishReason, type Run } from './events.ts'
import { jobNudge, WAIT_FOR, waitFor, type Fetcher } from './jobs.ts'
import { forLlm, paidFetch, type CallResult } from './paidFetch.ts'
import { walletSnapshot } from './wallet.ts'

type Msg = {
  role: string
  content: string | null | unknown[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
}
type ToolCall = { id: string; function: { name: string; arguments: string } }

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'http',
      description: 'Send an HTTP request. 402 payments are handled for you.',
      parameters: {
        type: 'object',
        required: ['method', 'url', 'reason'],
        properties: {
          method: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object' },
          body: { description: 'JSON body (object or string)' },
          reason: { type: 'string', description: 'one-line why, shown to the user' },
          filter: {
            type: 'string',
            description:
              'optional: return only the parts of a large response that mention this text (like grep)',
          },
        },
      },
    },
  },
  WAIT_FOR,
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Finish with the final answer in markdown.',
      parameters: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    },
  },
]
// Opt-in (sub-agents toggle), top-level runs only: sub-agents get just http, wait_for and done.
const SPAWN = {
  type: 'function',
  function: {
    name: 'spawn',
    description:
      'Start a sub-agent with a FRESH context: it sees only ' +
      '`task` (and `image_url`, which it can look at), never your conversation, and runs its own loop with its own budget carved from ' +
      'yours. Put in `task` only what that agent should know. Returns its final answer. Sub-agents cannot spawn.',
    parameters: {
      type: 'object',
      required: ['task', 'budget_usd', 'reason'],
      properties: {
        task: { type: 'string', description: "the sub-agent's entire prompt" },
        budget_usd: {
          type: 'number',
          description: 'its total budget, taken from your remaining budget',
        },
        image_url: {
          type: 'string',
          description:
            'optional public https image (JPEG/PNG/WebP under ~4 MB, e.g. a ~1024px thumbnail)',
        },
        label: { type: 'string', description: 'short name shown in the log, e.g. "describer-1"' },
        reason: { type: 'string', description: 'one-line why, shown to the user' },
      },
    },
  },
}

const CONTEXT_KEYS = ['id', 'name', 'serviceUrl', 'baseUrl', 'url'] // carried down from parent objects
const today = () =>
  new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) // for the system prompt

/** grep for responses: the deepest JSON array items (or text lines) mentioning `term`, with parent context. */
function filterText(text: string, term: string): string {
  const t = term.toLowerCase(),
    hit = (v: unknown) => JSON.stringify(v).toLowerCase().includes(t)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    const lines = text.split('\n').filter((l) => l.toLowerCase().includes(t))
    return lines.slice(0, 60).join('\n') || `(no lines mention "${term}")`
  }
  const out: unknown[] = []
  const walk = (v: any, ctx: Record<string, unknown>) => {
    if (out.length >= 25 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, ctx))
    const here = {
      ...ctx,
      ...Object.fromEntries(
        CONTEXT_KEYS.filter((k) => typeof v[k] === 'string').map((k) => [k, v[k]]),
      ),
    }
    const deeper = Object.values(v).some(
      (c) => Array.isArray(c) && c.some((x) => x && typeof x === 'object' && hit(x)),
    )
    if (deeper) return Object.values(v).forEach((c) => Array.isArray(c) && walk(c, here))
    if (hit(v)) out.push({ ...(Object.keys(ctx).length ? { parent: ctx } : {}), ...v })
  }
  walk(json, {})
  return out.length
    ? out.map((x) => JSON.stringify(x).slice(0, 1500)).join('\n')
    : `(no items mention "${term}")`
}

function receipt(run: Run, r: CallResult): string {
  const cost = `${usd(r.costUsd ?? 0)}${r.costIsQuote ? ' (quoted)' : ''}`
  const head =
    r.status === 'free'
      ? 'free'
      : r.status === 'blocked'
        ? `blocked: ${r.reason} · no charge`
        : r.status === 'paid'
          ? `paid ${cost} to ${r.host}`
          : r.status === 'paid_failed'
            ? `paid ${cost} but request failed (HTTP ${r.httpStatus})`
            : `failed: ${r.reason ?? `HTTP ${r.httpStatus}`} · no charge`
  return `[${head} · ${budgetLine(run)}]`
}

// Optional tool map (scripts/gen-hints.ts): verified endpoints so the agent skips most discovery steps.
const HINTS = readFileSync(new URL('./hints.md', import.meta.url), 'utf8').trim()

export const systemPrompt = (
  run: Run,
  image = false,
) => `You are an autonomous agent. You can only act through HTTP (the http tool, plus wait_for for async jobs); finish with done.${
  image
    ? `
The user's message includes an image and you can see it directly: look at it yourself, no tool is needed to view it.`
    : ''
}
Paid endpoints answer HTTP 402 and the harness pays automatically from your wallet, within your budget.
Budget now: ${budgetLine(run)}. Remaining: ${usd(run.budget.totalUsd - run.spent.totalUsd)}.
Every tool result starts with a receipt line in [brackets]; it is authoritative for what you paid and have left.
Discover services (all free):
- GET https://mpp.dev/services/llms.txt — compact list of MPP services.
- GET https://mpp.dev/api/services with filter:"<capability>" (e.g. "video", "weather") — official directory; items carry parent.serviceUrl, method, path, price.
- GET https://mercator.sh/v1/services/search?query=<need>&limit=8, then GET https://mercator.sh/v1/services/<serviceId> for service.serviceUrl. Ids starting "x402-" are usually Base-only: this wallet can't pay them.
- Tempo proxies (*.mpp.tempo.xyz) are listed in https://mpp.tempo.xyz/openapi.json. StableStudio lives at https://stablestudio.dev.
- If a service's /llms.txt or /openapi.json 404s, use the directory's path and schema. The live 402 quote is the real price.
- Media generation (image/video/audio) can take 30–90s per call; that is normal. Put media URLs in your final answer so they display.
- Async jobs (most video): submit with http; if the response has a status_url/response_url or is HTTP 202, call wait_for once.
  The harness then polls in code (no steps spent) and returns the result. Never poll with repeated http calls.
Prefer services on *.mpp.tempo.xyz (reliable, fee-sponsored). Read a service's docs before calling it.
Before any call quoted above $0.10, check its input schema and send exactly the documented fields and types: many servers charge before validating.
Ground research in real data: when a task needs current facts or trends, use a paid search or data service, and cite what you found.
Today is ${today()}. Your training data is older: for anything current ("trending", "latest", news, prices), search with this date in mind and don't assume a year.
Never send secrets. Never take side-effect actions (email, mail, purchases, calls) unless the task explicitly asks and the harness allows it.
Be frugal: inference is paid too. Make independent http calls together in ONE turn (parallel tool calls). Keep the final answer concise,
and wrap up with done when you are close to any limit.${
  run.hints
    ? `

Known-good tools (verified recently; the live 402 quote is authoritative):
${HINTS}`
    : ''
}`

/** Keep the 3 newest tool results in full; older ones shrink to their receipt line + a short preview. */
function compact(history: Msg[]): Msg[] {
  const tools = history.flatMap((m, i) => (m.role === 'tool' ? [i] : [])),
    keep = new Set(tools.slice(-3))
  return history.map((m, i) =>
    m.role !== 'tool' || keep.has(i) || typeof m.content !== 'string' || m.content.length <= 600
      ? m
      : {
          ...m,
          content:
            m.content.slice(0, m.content.indexOf('\n') + 1 + 300) + ' … [older result compacted]',
        },
  )
}

/** wait_for's polls are ordinary paid calls: always paidFetch (blocklist, policy, budget, allowance, receipts). */
const pollVia =
  (run: Run): Fetcher =>
  (url, init, ctx) =>
    paidFetch(run, ctx, url, init)

/** Run a sub-agent to completion, then fold its spend into the parent's. */
async function spawn(run: Run, step: number, args: Record<string, any>): Promise<string> {
  const task = String(args.task ?? '').trim(),
    b = run.budget,
    s = run.spent,
    left = b.totalUsd - s.totalUsd
  const total = Math.min(Number(args.budget_usd) || 0, left)
  if (!task || !(total > 0))
    return `spawn rejected: needs a task and budget_usd > 0 (you have ${usd(left)} left). No charge.`
  const label =
    String(args.label || `sub-agent-${run.subagents + 1}`)
      .replace(/[^\w-]/g, '')
      .slice(0, 24) || `sub-agent-${run.subagents + 1}`
  run.subagents++
  const child = createRun(
    task,
    run.hints,
    {
      totalUsd: total,
      inferenceUsd: Math.min(total, b.inferenceUsd - s.llm),
      toolsUsd: Math.min(total, b.toolsUsd - s.http),
      perCallUsd: Math.min(total, b.perCallUsd),
    },
    { parent: run, label },
  )
  const image =
    typeof args.image_url === 'string' && URL.canParse(args.image_url) ? args.image_url : undefined
  emit(run, 'agent.thought', {
    step,
    text: `**Sub-agent ${label} started**: fresh context, own loop, ${usd(total)} budget${image ? ', plus an image' : ''}. Its entire prompt:\n\n> ${task}`,
  })
  const { reason, answer } = await runAgent(child, image)
  for (const k of ['totalUsd', 'llm', 'http', 'payments'] as const) s[k] += child.spent[k]
  for (const [h, v] of Object.entries(child.spent.byService)) {
    const x = (s.byService[h] ??= { calls: 0, spentUsd: 0 })
    x.calls += v.calls
    x.spentUsd += v.spentUsd
  }
  emit(run, 'agent.thought', {
    step,
    text: `**Sub-agent ${label} finished** (${reason}) after spending ${usd(child.spent.totalUsd)}.`,
  })
  emit(run, 'wallet.balance', {
    ...(await walletSnapshot()),
    spentUsd: s.totalUsd,
    spentInferenceUsd: s.llm,
    spentToolsUsd: s.http,
    payments: s.payments,
  })
  return `[sub-agent ${label} ${reason} · spent ${usd(child.spent.totalUsd)} · ${budgetLine(run)}]\n${answer}`
}

export async function runAgent(
  run: Run,
  image?: string,
): Promise<{ reason: FinishReason; answer: string }> {
  const first = image
    ? [
        { type: 'text', text: run.task },
        { type: 'image_url', image_url: { url: image } },
      ]
    : run.task
  const history: Msg[] = [{ role: 'user', content: first }]
  const thoughts: string[] = []
  const tools = run.subagentsAllowed && !run.parent ? [...TOOLS, SPAWN] : TOOLS,
    maxSteps = run.parent ? Math.min(12, config.maxSteps) : config.maxSteps
  const finish = (reason: FinishReason, answer: string) => {
    run.finished = true
    emit(run, 'run.finished', { reason, answer, totals: totals(run) })
    return { reason, answer }
  }
  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (run.stopRequested || run.parent?.stopRequested)
        return finish('stopped', 'Stopped by user.')
      const messages = [
        { role: 'system', content: systemPrompt(run, !!image) },
        ...compact(history),
      ] // rebuilt every turn
      const llm = await paidFetch(
        run,
        { step, kind: 'llm', reason: `think (step ${step})` },
        config.llmUrl,
        {
          method: 'POST',
          body: JSON.stringify({ model: config.model, messages, tools, max_tokens: 800 }),
        },
      )
      if (llm.status === 'blocked') {
        if (config.dryRun)
          return finish(
            'stopped',
            `Dry run: stopped before the first paid LLM call (${llm.reason}).`,
          )
        return finish(
          'budget',
          `Budget exhausted (${llm.reason}).\n\n${thoughts.join('\n\n') || 'Nothing learned yet.'}`,
        )
      }
      if (llm.httpStatus !== 200)
        throw new Error(`LLM call failed (HTTP ${llm.httpStatus}): ${llm.text.slice(0, 300)}`)
      const msg: { content: string | null; tool_calls?: ToolCall[] } = JSON.parse(llm.text)
        .choices[0].message
      history.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })
      if (!msg.tool_calls?.length) {
        if (msg.content?.trim()) return finish('done', msg.content)
        history.push({
          role: 'user',
          content: 'Continue: call a tool, or call done with your answer.',
        })
        continue
      }
      if (msg.content?.trim()) {
        thoughts.push(msg.content)
        emit(run, 'agent.thought', { step, text: msg.content })
      }
      for (const call of msg.tool_calls) {
        let args: Record<string, any> = {}
        try {
          args = JSON.parse(call.function.arguments || '{}')
        } catch {}
        if (call.function.name === 'done') {
          const answer = String(args.answer ?? '').trim()
          if (answer) return finish('done', answer)
          // Empty or truncated (usually hit max_tokens): ask for a shorter answer instead of finishing silently.
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'done was empty or truncated (output limit). Call done again with a concise answer (under 250 words).',
          })
          continue
        }
        let content = `unknown tool ${call.function.name}`
        if (call.function.name === 'spawn' && run.subagentsAllowed && !run.parent)
          content = await spawn(run, step, args)
        else if (call.function.name === 'wait_for')
          content = await waitFor(run, step, args, pollVia(run))
        else if (
          call.function.name === 'http' &&
          !(typeof args.url === 'string' && URL.canParse(args.url))
        ) {
          content =
            'http call rejected before sending: "url" must be a full https:// URL. No charge.' // malformed tool call
        } else if (call.function.name === 'http') {
          const body =
            args.body === undefined
              ? undefined
              : typeof args.body === 'string'
                ? args.body
                : JSON.stringify(args.body)
          const r = await paidFetch(
            run,
            { step, kind: 'http', reason: String(args.reason ?? '') },
            String(args.url),
            { method: args.method ?? 'GET', headers: args.headers, body },
          )
          const shown = args.filter ? filterText(r.text, String(args.filter)) : r.text
          content = `${receipt(run, r)}\nHTTP ${r.httpStatus}${args.filter ? ` (filtered: "${args.filter}")` : ''}\n${forLlm(shown)}${jobNudge(run, r, String(args.url))}`
        }
        history.push({ role: 'tool', tool_call_id: call.id, content })
      }
    }
    return finish('max_steps', `Reached MAX_STEPS (${maxSteps}).\n\n${thoughts.join('\n\n')}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit(run, 'run.error', { message })
    return finish('error', message)
  }
}
