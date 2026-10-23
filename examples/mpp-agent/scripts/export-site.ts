// Export curated runs as a static, self-contained site for static hosting: `pnpm run export`.
// Reads site.config.json, writes <out>/ (default dist-site/). No paid calls: only free RPC reads
// (to bake on-chain verification) and downloads of media the agent produced.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'

import {
  answerMedia,
  indexDoc,
  mediaKind,
  parseEvents,
  runDoc,
  summarizeRun,
  type Media,
} from '../src/runview.ts'
import { verifyRun } from '../src/verify.ts'

type RunCfg = { id: string; emoji?: string; title?: string }
const cfg = JSON.parse(readFileSync('site.config.json', 'utf8')) as {
  out?: string
  title?: string
  runs: RunCfg[]
}
const OUT = cfg.out ?? 'dist-site'
const MAX = Math.floor(1.9 * 1024 * 1024) // stay under a 2 MiB per-file limit (common on static hosts)

// Shorten 40-hex addresses (wallets, recipients, token contracts). 64-hex tx hashes stay intact.
const shorten = (s: string) =>
  s.replace(/0x([0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})(?![0-9a-fA-F])/g, '0x$1…$2')
const FULL_ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'pipe' })
const size = (p: string) => statSync(p).size

rmSync(OUT, { recursive: true, force: true })
for (const d of ['data/runs', 'media']) mkdirSync(join(OUT, d), { recursive: true })
// Self-contained: html, site.css, site.js. try.html is the live app's run page (needs the server), so it's not exported.
for (const f of readdirSync('site').filter((f) => f !== 'try.html'))
  copyFileSync(join('site', f), join(OUT, f))
copyFileSync('SKILL.md', join(OUT, 'SKILL.md')) // served next to the gallery for 'paste into Claude' setup

/** Download one media URL into media/, shrink it under the size cap, return its local path (or null + why). */
async function localize(
  url: string,
  base: string,
): Promise<{ path: string | null; poster?: string; note?: string; bytes?: number }> {
  const kind = mediaKind(url),
    tmp = join('/tmp', `export-${base}${extname(new URL(url).pathname)}`)
  const r = await fetch(url).catch(() => null)
  if (!r?.ok) return { path: null, note: `download failed (${r?.status ?? 'network'})` }
  writeFileSync(tmp, Buffer.from(await r.arrayBuffer()))
  if (kind === 'image') {
    const out = join(OUT, 'media', `${base}.jpg`)
    for (const [px, q] of [
      [1200, 80],
      [1000, 70],
      [800, 60],
    ] as const) {
      run('sips', [
        '-Z',
        String(px),
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        String(q),
        tmp,
        '--out',
        out,
      ])
      if (size(out) <= 400 * 1024) break
    }
    return size(out) <= MAX
      ? { path: `media/${base}.jpg`, bytes: size(out) }
      : (rmSync(out), { path: null, note: 'image too large' })
  }
  if (kind === 'video') {
    const out = join(OUT, 'media', `${base}.mp4`)
    for (const preset of [
      'Preset960x540',
      'Preset640x480',
      'PresetMediumQuality',
      'PresetLowQuality',
    ]) {
      try {
        run('avconvert', ['-s', tmp, '-p', preset, '-o', out, '--replace'])
      } catch {
        continue
      }
      if (existsSync(out) && size(out) <= MAX) break
    }
    if (!existsSync(out) || size(out) > MAX) {
      rmSync(out, { force: true })
      return { path: null, note: 'video too large after re-encode' }
    }
    let poster: string | undefined
    try {
      // Quick Look renders a frame; convert it to a small JPEG poster.
      run('qlmanage', ['-t', '-s', '960', '-o', '/tmp', tmp])
      const png = `${tmp}.png`,
        p = join(OUT, 'media', `${base}-poster.jpg`)
      run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', png, '--out', p])
      poster = `media/${base}-poster.jpg`
    } catch {
      /* poster is optional */
    }
    return { path: `media/${base}.mp4`, poster, bytes: size(out) }
  }
  const out = join(OUT, 'media', `${base}${extname(new URL(url).pathname).toLowerCase()}`)
  copyFileSync(tmp, out)
  return size(out) <= MAX
    ? { path: out.slice(OUT.length + 1), bytes: size(out) }
    : (rmSync(out), { path: null, note: 'audio too large' })
}

const rows: ReturnType<typeof summarizeRun>[] = []
const report: string[] = []

for (const rc of cfg.runs) {
  const file = `runs/${rc.id}.jsonl`
  if (!existsSync(file)) {
    report.push(`SKIP ${rc.id}: missing`)
    continue
  }
  const events = parseEvents(readFileSync(file, 'utf8'))
  const start = events.find((e) => e.type === 'run.started'),
    fin = events.find((e) => e.type === 'run.finished')
  if (!start || !fin || fin.reason !== 'done') {
    report.push(`SKIP ${rc.id}: not a finished run`)
    continue
  }

  const verification = await verifyRun(events).catch((e) => ({
    ok: false,
    error: String(e?.message ?? e),
  }))

  // Media the agent delivered (in its final answer): self-host it, rewrite the references.
  const media: (Media & { url: string; bytes?: number })[] = []
  for (const [n, url] of answerMedia(String(fin.answer ?? '')).entries()) {
    const m = await localize(url, `${rc.id.slice(-4)}-${n + 1}`)
    media.push({ url, kind: mediaKind(url), ...m, original: m.path ? undefined : url })
  }
  let answer = String(fin.answer ?? '')
  for (const m of media) if (m.path) answer = answer.split(m.url).join(m.path)

  const outEvents = events.map((e) => (e.type === 'run.finished' ? { ...e, answer } : e))
  const row = summarizeRun(rc.id, outEvents, rc, { media })
  rows.push(row)
  writeFileSync(
    join(OUT, 'data/runs', `${rc.id}.json`),
    shorten(JSON.stringify(runDoc(row.summary, outEvents, verification))),
  )
  // job.waiting / job.finished events (wait_for) pass through untouched; site.js folds each job's polls into one row.
  report.push(
    `RUN ${rc.id} ${rc.emoji ?? ''} ${rc.title ?? ''}: $${row.summary.spentUsd.toFixed(4)}, ${row.summary.payments} payments, ` +
      (row.summary.jobs ? `${row.summary.jobs} async jobs (${row.summary.polls} polls), ` : '') +
      `verify ${(verification as { ok?: boolean }).ok ? 'ok' : 'FAILED'}, media ${media.map((m) => `${m.kind}:${m.path ? `${Math.round((m.bytes ?? 0) / 1024)}KB` : `excluded (${m.note})`}`).join(', ') || 'none'}`,
  )
}
writeFileSync(join(OUT, 'data/index.json'), shorten(JSON.stringify(indexDoc(cfg.title, rows))))

// Checks: every file under the per-file size limit, no full 40-hex addresses anywhere.
let total = 0,
  bad = 0
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) =>
    statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
  )
for (const f of walk(OUT)) {
  const s = size(f)
  total += s
  if (s > 2 * 1024 * 1024) {
    report.push(`TOO BIG ${f} ${s}`)
    bad++
  }
  if (/\.(json|html|js|css|md)$/.test(f) && FULL_ADDR.test(readFileSync(f, 'utf8'))) {
    report.push(`FULL ADDRESS in ${f}`)
    bad++
  }
}
report.push(`TOTAL ${walk(OUT).length} files, ${(total / 1024 / 1024).toFixed(2)} MiB in ${OUT}/`)
console.log(report.join('\n'))
process.exit(bad ? 1 : 0)
