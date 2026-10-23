// Run shaping shared by the static exporter (scripts/export-site.ts) and the live server (/api/site/*),
// so the site's front end sees identical data in both modes. Pure: no wallet, no network, no disk.
import type { Event } from './events.ts'

export type Media = {
  kind: 'image' | 'video' | 'audio'
  path: string | null
  poster?: string
  note?: string
  original?: string
}
export type RunMeta = { emoji?: string; title?: string }
export type RunStatus =
  | 'done'
  | 'stopped'
  | 'budget'
  | 'max_steps'
  | 'error'
  | 'running'
  | 'incomplete'
type ByService = Record<string, { calls: number; spentUsd: number }>
type Ev = Event & Record<string, any>

export const MEDIA_RE =
  /https?:\/\/[^\s"'<>()[\]\\]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg)(?=[\s"'<>()[\]\\?]|$)/gi
export const mediaKind = (url: string): Media['kind'] =>
  /\.(mp4|webm|mov)$/i.test(url) ? 'video' : /\.(mp3|wav|m4a|ogg)$/i.test(url) ? 'audio' : 'image'
/** Media URLs the agent delivered in its final answer, in order, de-duplicated. */
export const answerMedia = (answer: string) => [...new Set<string>(answer.match(MEDIA_RE) ?? [])]

export const parseEvents = (jsonl: string): Ev[] =>
  jsonl
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      } // a half-written last line while a run is active
    })

/** Spend by service and by kind. Uses run.finished totals when present, otherwise derives them from the events. */
export function runTotals(evs: Ev[]) {
  const fin = evs.find((e) => e.type === 'run.finished')
  if (fin?.totals)
    return fin.totals as {
      spentUsd: number
      payments: number
      byService: ByService
      byKind: { llm: number; http: number }
    }
  const calls = new Map(evs.filter((e) => e.type === 'call.started').map((e) => [e.callId, e]))
  const byService: ByService = {},
    byKind = { llm: 0, http: 0 }
  for (const c of calls.values()) (byService[c.host] ??= { calls: 0, spentUsd: 0 }).calls++
  const paid = evs.filter((e) => e.type === 'call.paid')
  for (const p of paid) {
    const c = calls.get(p.callId)
    byKind[c?.kind === 'llm' ? 'llm' : 'http'] += p.chargedUsd
    if (c) byService[c.host].spentUsd += p.chargedUsd
  }
  return { spentUsd: byKind.llm + byKind.http, payments: paid.length, byService, byKind }
}

export function runStatus(evs: Ev[], active = false): RunStatus {
  const fin = evs.find((e) => e.type === 'run.finished')
  if (fin) return fin.reason as RunStatus
  if (active) return 'running'
  return evs.some((e) => e.type === 'run.error') ? 'error' : 'incomplete'
}

/**
 * One run's summary (the card and run-page header). `media` defaults to the answer's original URLs
 * (live mode); the exporter passes self-hosted copies instead.
 */
export function summarizeRun(
  id: string,
  evs: Ev[],
  meta: RunMeta = {},
  opts: { active?: boolean; media?: Media[] } = {},
) {
  const start = evs.find((e) => e.type === 'run.started'),
    fin = evs.find((e) => e.type === 'run.finished')
  const t = runTotals(evs)
  const media: Media[] =
    opts.media ??
    answerMedia(String(fin?.answer ?? '')).map((url) => ({ kind: mediaKind(url), path: url }))
  const paidHosts = Object.entries(t.byService)
    .filter(([, v]) => v.spentUsd > 0)
    .map(([h]) => h)
  const last = evs[evs.length - 1]
  const task = String(start?.task ?? '')
  const summary = {
    id,
    emoji: meta.emoji ?? '🤖',
    title: meta.title ?? (task.length > 60 ? task.slice(0, 57).trimEnd() + '…' : task || id),
    task,
    status: runStatus(evs, opts.active),
    startedAt: start?.ts ?? null,
    finishedAt: fin?.ts ?? null,
    durationSec:
      start && (fin ?? last)
        ? Math.round((Date.parse((fin ?? last).ts) - Date.parse(start.ts)) / 1000)
        : null,
    model: start?.model ?? null,
    hints: start?.hints ?? null,
    budget: start?.budget ?? null,
    spentUsd: t.spentUsd ?? 0,
    payments: t.payments ?? 0,
    byKind: t.byKind ?? { llm: 0, http: 0 },
    paidServices: paidHosts,
    toolServices: paidHosts.filter((h) => !h.startsWith('openrouter.')).length,
    calls: evs.filter((e) => e.type === 'call.started').length, // includes wait_for polls (each is a real HTTP call)
    jobs: new Set(evs.filter((e) => e.type === 'job.waiting').map((e) => e.jobId)).size, // wait_for jobs; 0 on older runs
    polls: evs.filter((e) => e.type === 'call.started' && e.role === 'poll').length,
    blocked: evs.filter(
      (e) =>
        (e.type === 'call.policy' && e.decision === 'deny') ||
        (e.type === 'call.finished' && e.status === 'blocked'),
    ).length,
    thumb:
      media.find((m) => m.kind === 'image' && m.path)?.path ??
      media.find((m) => m.poster)?.poster ??
      null,
    media: media.map(({ kind, path, poster, note, original }) => ({
      kind,
      path,
      poster,
      note,
      original,
    })),
  }
  return { summary, byService: t.byService }
}
export type RunSummary = ReturnType<typeof summarizeRun>['summary']

/** data/runs/<id>.json and GET /api/site/runs/:id */
export const runDoc = (summary: RunSummary, events: Ev[], verification: unknown = null) => ({
  summary,
  verification,
  events,
})

/** data/index.json and GET /api/site/index: cards plus all-time totals across the given runs. */
export function indexDoc(
  title: string | undefined,
  rows: { summary: RunSummary; byService: ByService }[],
) {
  const all = { spentUsd: 0, payments: 0, llm: 0, http: 0, byService: {} as ByService }
  for (const { summary: s, byService } of rows) {
    all.spentUsd += s.spentUsd
    all.payments += s.payments
    all.llm += s.byKind.llm ?? 0
    all.http += s.byKind.http ?? 0
    for (const [h, v] of Object.entries(byService)) {
      const x = (all.byService[h] ??= { calls: 0, spentUsd: 0 })
      x.calls += v.calls
      x.spentUsd += v.spentUsd
    }
  }
  const topServices = Object.entries(all.byService)
    .filter(([, v]) => v.spentUsd > 0)
    .sort((a, b) => b[1].spentUsd - a[1].spentUsd)
    .map(([host, v]) => ({ host, calls: v.calls, spentUsd: Math.round(v.spentUsd * 1e6) / 1e6 }))
  return {
    title,
    generatedAt: new Date().toISOString(),
    runs: rows.map((r, order) => ({ ...r.summary, order })),
    totals: {
      spentUsd: all.spentUsd,
      payments: all.payments,
      runs: rows.length,
      byKind: { llm: all.llm, http: all.http },
      topServices,
    },
  }
}
