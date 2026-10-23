// Regenerates src/hints.md from runs/catalog-probe.json (live quotes) + the probe bodies in scripts/probe-catalog.ts.
// Usage: pnpm exec tsx scripts/gen-hints.ts. Curated: which ids to include, their gotchas, and the two video EXTRAS
// (2026-10-09: grok video paid $0.50 sync in 65s; minimax h3 needs numeric `duration`. 2026-10-21: both moved to the
// async queue at fal-queue.mpp.tempo.xyz; unpaid 402 quotes $0.50 (grok) and $0.576 (h3-max, duration 6); status
// GETs are unpriced in mpp.tempo.xyz/openapi.json, and an unpaid GET of a bogus request id answered 404, not 402).
import { readFileSync, writeFileSync } from 'node:fs'

type Result = {
  id: string
  cap: string
  method: string
  url: string
  status: string
  quotedUsd?: number
  feePayer?: boolean
}
const probe: { probedAt: string; results: Result[] } = JSON.parse(
  readFileSync('runs/catalog-probe.json', 'utf8'),
)
const src = readFileSync('scripts/probe-catalog.ts', 'utf8')

// Probe bodies are JS object literals; pull each id's `body: {...}` and print it as compact JSON-ish text.
function bodyOf(id: string): string {
  const line = src.split('\n').find((l) => l.includes(`id: '${id}'`))
  const m = line?.match(/body: (\{.*?\})(, docs|, method| \})/)
  if (!m) return ''
  // Keep exact field names and short values (ids, enums, numbers); elide long example strings to stay compact.
  try {
    return JSON.stringify(Function(`return (${m[1]})`)(), (_k, v) =>
      typeof v === 'string' && v.length > 14 ? '…' : v,
    )
  } catch {
    return m[1]
  }
}

const PICK: [id: string, note?: string][] = [
  ['firecrawl-search', 'returns data[] of url/title/description'],
  ['parallel'],
  ['serper'],
  ['serper-places'],
  ['glim-x'],
  ['glim', 'Reddit'],
  ['firecrawl'],
  ['fal-schnell', 'returns images[].url'],
  ['fal-recraft-v3', 'good with text in images'],
  ['fal-elevenlabs', 'returns audio.url mp3'],
  ['openweather', 'lat/lon: geocode first'],
  ['mapbox', 'returns lat/lon'],
  ['deepl', 'text is an array'],
  ['alphavantage'],
  ['edgar', '10-digit cik (NVIDIA 0001045810); large response'],
  ['tako', 'returns chart URLs'],
  ['builtwith'],
  ['coingecko'],
  ['cryptonews'],
  ['rentcast'],
  ['judge0', 'language_id 71 = Python 3'],
  ['wolfram'],
  ['kicksdb'],
  ['rxatlas'],
  ['trialbase'],
  ['recallradar'],
]
const EXTRAS = [
  'text-to-video (async): POST https://fal-queue.mpp.tempo.xyz/xai/grok-imagine-video/text-to-video {"prompt":"…"} · $0.50 · ' +
    'returns status_url + response_url: call wait_for {"url":status_url,"until":{"field":"status","in":["COMPLETED"]},"then":response_url} (status polls unpriced); result has video.url mp4',
  'text-to-video (async): POST https://fal-queue.mpp.tempo.xyz/minimax/h3-max/text-to-video {"prompt":"…","duration":6} · ~$0.58 · duration is a NUMBER; same submit → wait_for flow',
]

const byId = new Map(probe.results.map((r) => [r.id, r]))
const lines = PICK.flatMap(([id, note]) => {
  const r = byId.get(id)
  if (!r || r.status !== 'PAYABLE') return []
  const body = r.method === 'GET' ? '' : ` ${bodyOf(id)}`
  const gas = r.feePayer ? '' : ' · +gas'
  const url = r.method === 'GET' ? r.url : r.url.replace(/\?.*$/, '')
  return [
    `${r.cap}: ${r.method} ${url}${body} · $${Number(r.quotedUsd).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}${gas}${note ? ` · ${note}` : ''}`,
  ]
})
const out =
  `capability: METHOD URL body · quote · notes ("…" = your value; +gas = not fee-sponsored)\n` +
  [...lines, ...EXTRAS].map((l) => `- ${l}`).join('\n') +
  '\n'
writeFileSync('src/hints.md', out)
console.log(
  `wrote src/hints.md: ${lines.length + EXTRAS.length} tools, ${out.length} bytes (probe ${probe.probedAt})`,
)
