/* mpp-agent static gallery: recorded runs, rendered read-only.
   CSP-safe: no inline scripts or handlers, same-origin fetches only. All event data is untrusted:
   it reaches the DOM through textContent, or through renderMarkdown(), which escapes HTML first. */
;(() => {
  'use strict'

  // ------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id)
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const EXPLORER = 'https://explore.tempo.xyz/tx/'
  const REPO_URL = 'https://github.com/wevm/mppx/tree/main/examples/mpp-agent'
  const SKILL_URL = 'SKILL.md'
  const TOKENS = { '0x20c0…8b50': 'USDC.e' } // addresses are shortened in the exported data
  const CHAINS = { 4217: 'Tempo mainnet', 42431: 'Tempo Moderato (testnet)' }
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's')

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function add(parent, ...kids) {
    kids.forEach((k) => {
      if (k != null) parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k)
    })
    return parent
  }
  /** Money: 4 decimals, 6 below $0.001. */
  function fmtUsd(v) {
    v = num(v)
    if (v == null) return '—'
    const a = Math.abs(v)
    return (v < 0 ? '−$' : '$') + a.toFixed(a > 0 && a < 0.001 ? 6 : 4)
  }
  const pct = (v, sum) => (sum ? Math.round((v / sum) * 100) : 0)
  const fmtDate = (iso) => {
    const d = new Date(iso)
    return isNaN(d)
      ? ''
      : d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
  }
  const fmtDur = (s) =>
    num(s) == null ? '—' : s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  const isTxHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(h)
  function link(href, text, cls) {
    const a = el('a', cls || null, text)
    a.href = href
    if (/^https?:/i.test(href)) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    return a
  }
  function txLink(hash, full) {
    hash = str(hash)
    const label = full || hash.length <= 14 ? hash : hash.slice(0, 8) + '…' + hash.slice(-4)
    if (!isTxHash(hash)) return el('span', 'mono', label)
    const a = link(EXPLORER + hash, label, 'tx')
    a.title = hash + ' (opens Tempo explorer)'
    a.setAttribute(
      'aria-label',
      'Transaction ' + hash.slice(0, 10) + ' on Tempo explorer (new tab)',
    )
    return a
  }
  function splitUrl(url, host) {
    try {
      const u = new URL(str(url))
      return { host: host || u.host, path: u.pathname + u.search }
    } catch {
      return { host: host || '', path: str(url) }
    }
  }
  const truncPath = (p, max = 48) =>
    p.length <= max ? p : p.slice(0, max - 15) + '…' + p.slice(-14)
  async function getJSON(path) {
    const r = await fetch(path)
    if (!r.ok) throw new Error(path + ': HTTP ' + r.status)
    return r.json()
  }
  // ------------------------------------------------------------ config + data adapter
  // Pages only call data.* (and live.* for live-only actions); nav labels come from CONFIG.
  // Static (static hosting): the exported JSON. Live (`pnpm dev`): src/server.ts marks <body data-mode="live">
  // and serves the same shapes from /api/site/* (both built by src/runview.ts).
  const LIVE = document.body.dataset.mode === 'live'
  const CONFIG = LIVE
    ? {
        mode: 'live',
        nav: { try: 'Try it', index: 'History', how: 'How this works' },
        backToIndex: '← History',
      }
    : { mode: 'static', nav: { index: 'Runs', how: 'How this works' }, backToIndex: '← All runs' }
  const enc = encodeURIComponent
  const data = LIVE
    ? {
        index: () => getJSON('api/site/index'),
        run: (id) => getJSON('api/site/runs/' + enc(id)),
        skill: () => getText(SKILL_URL),
      }
    : {
        index: () => getJSON('data/index.json'),
        run: (id) => getJSON('data/runs/' + enc(id) + '.json'),
        skill: () => getText(SKILL_URL),
      }
  /** Live-only server actions (never called on the static site). */
  const live = {
    wallet: () => getJSON('api/wallet'),
    start: async (body) => {
      const r = await fetch('api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.status === 409)
        throw new Error('A run is already in progress. Wait for it to finish, or stop it first.')
      if (!r.ok) throw new Error('Could not start the run (HTTP ' + r.status + ').')
      return r.json()
    },
    stop: async (id) => {
      const r = await fetch('api/runs/' + enc(id) + '/stop', { method: 'POST' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
    },
    verifyRun: (id) => getJSON('api/runs/' + enc(id) + '/verify'),
    verifyWallet: () => getJSON('api/verify/wallet'),
  }

  /**
   * Follow a run's SSE stream. The server replays every past event on each (re)connect, so skip what we
   * already have: `have` events were rendered before connecting (e.g. from data.run()).
   */
  function streamRun(id, have, onEvent, onState) {
    let received = have,
      skip = 0
    const es = new EventSource('api/runs/' + enc(id) + '/events')
    es.addEventListener('open', () => {
      skip = received
      onState?.('live')
    })
    es.onmessage = (m) => {
      if (skip > 0) {
        skip--
        return
      }
      received++
      let ev
      try {
        ev = JSON.parse(m.data)
      } catch {
        return
      }
      if (!ev || (ev.runId && str(ev.runId) !== id)) return
      onEvent(ev)
      if (ev.type === 'run.finished') {
        es.close()
        onState?.('finished')
      }
    }
    es.onerror = () => {
      onState?.(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }
    return es
  }
  async function getText(path) {
    const r = await fetch(path)
    if (!r.ok) throw new Error(path + ': HTTP ' + r.status)
    return r.text()
  }

  function fail(box, msg) {
    box.textContent = ''
    box.appendChild(el('p', 'error-banner', msg))
  }

  // --------------------------------------------- markdown (escape first)
  function escapeHtml(s) {
    return str(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
  const LOCAL = /^media\/[\w.-]+$/ // self-hosted media written by the export
  const ext = (src) => (src.split('?')[0].match(/\.(\w+)$/) || [])[1] || ''
  const isVideo = (src) => /^(mp4|webm|mov)$/i.test(ext(src))
  const isAudio = (src) => /^(mp3|wav|m4a|ogg)$/i.test(ext(src))
  const isImage = (src) => /^(png|jpe?g|webp|gif)$/i.test(ext(src))
  let POSTERS = {} // video path -> poster path, from the run summary (set before rendering an answer)
  let SEEN = new Set() // self-hosted media already rendered as a player in this document (reset per render)
  // src arrives HTML-escaped, so it's attribute-safe. Static: external media can't load under the Pages CSP, so
  // link it instead. Live: the server's CSP allows https media, so provider-hosted files play inline.
  const playable = (src) => LOCAL.test(src) || (LIVE && /^https:\/\//i.test(src))
  function mediaHtml(src, alt, text) {
    if (playable(src) && SEEN.has(src)) {
      // second reference to the same file: a plain link, not another player
      return text
        ? '<a href="' +
            src +
            '"' +
            (LOCAL.test(src) ? '' : ' target="_blank" rel="noopener noreferrer"') +
            '>' +
            mdEmph(text) +
            '</a>'
        : ''
    }
    if (playable(src)) SEEN.add(src)
    if (!playable(src)) {
      const kind = isVideo(src) ? 'Video' : isAudio(src) ? 'Audio' : 'Image'
      return (
        '<span class="ext-media">' +
        kind +
        ' (not self-hosted): <a href="' +
        src +
        '" target="_blank" rel="noopener noreferrer">open original ↗</a></span>'
      )
    }
    if (isVideo(src)) {
      const poster = LOCAL.test(POSTERS[src] || '')
        ? ' poster="' + escapeHtml(POSTERS[src]) + '"'
        : ''
      return (
        '<span class="md-video"><video src="' +
        src +
        '"' +
        poster +
        ' controls playsinline preload="metadata"' +
        (alt ? ' aria-label="' + alt + '"' : ' aria-label="Video the agent generated"') +
        '></video></span>'
      )
    }
    if (isAudio(src))
      return (
        '<span class="md-audio"><audio src="' +
        src +
        '" controls preload="metadata" aria-label="' +
        (alt || 'Audio the agent generated') +
        '"></audio></span>'
      )
    return (
      '<span class="md-img"><img src="' +
      src +
      '" alt="' +
      (alt || 'Image the agent generated') +
      '" loading="lazy"></span>'
    )
  }
  const isMedia = (src) =>
    (LOCAL.test(src) || /^https?:\/\//i.test(src)) && (isVideo(src) || isAudio(src) || isImage(src))
  function mdEmph(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
  }
  function mdInline(s) {
    const slots = []
    const hold = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000'
    s = s.replace(/`([^`]+)`/g, (_, c) => hold('<code>' + c + '</code>'))
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) =>
      isMedia(src) ? hold(mediaHtml(src, alt)) : alt || '',
    )
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
      if (isMedia(url)) return /\u0000/.test(text) ? text : hold(mediaHtml(url, '', text)) // [![x](a.mp4)](a.mp4): keep the inner player
      if (!/^https?:\/\//i.test(url)) return text
      return hold(
        '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + mdEmph(text) + '</a>',
      )
    })
    s = s.replace(
      /(^|[\s(])((?:https?:\/\/|media\/)[^\s<>()\u0000]+?\.(?:mp4|webm|mov|mp3|wav|m4a|ogg|png|jpe?g|webp|gif))(?=$|[\s).,;:!])/gi,
      (_, pre, url) => pre + hold(mediaHtml(url, '')),
    )
    s = s.replace(
      /(^|[\s(])(https?:\/\/[^\s<>()\u0000]+)/g,
      (_, pre, url) =>
        pre +
        hold('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'),
    )
    return mdEmph(s).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i])
  }
  /** Mount renderMarkdown() output. It escapes all input before adding markup, so parse it inertly and move the nodes in. */
  function setMarkdownHtml(node, html) {
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html')
    node.replaceChildren(...doc.body.childNodes)
  }
  /** shift: markdown '#' renders as h(1 + shift). The run answer sits under an h2, so it uses shift 2. */
  function renderMarkdown(src, shift = 1) {
    SEEN = new Set()
    const lines = escapeHtml(str(src).replace(/\u0000/g, '')).split(/\r?\n/)
    const out = []
    let para = [],
      list = null
    const flush = () => {
      if (para.length) out.push('<p>' + mdInline(para.join(' ')) + '</p>')
      para = []
    }
    const close = () => {
      if (list) out.push('</' + list + '>')
      list = null
    }
    const cells = (l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m
      if (/^\s*```/.test(line)) {
        flush()
        close()
        const code = []
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
        out.push('<pre><code>' + code.join('\n') + '</code></pre>')
      } else if (
        /^\s*\|.*\|\s*$/.test(line) &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '') &&
        /-/.test(lines[i + 1])
      ) {
        flush()
        close()
        const head = cells(line)
        const rows = []
        for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++)
          rows.push(cells(lines[i]))
        i--
        out.push(
          '<table><thead><tr>' +
            head.map((h) => '<th>' + mdInline(h) + '</th>').join('') +
            '</tr></thead><tbody>' +
            rows
              .map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>')
              .join('') +
            '</tbody></table>',
        )
      } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush()
        close()
        const lvl = Math.min(m[1].length + shift, 6)
        out.push('<h' + lvl + '>' + mdInline(m[2]) + '</h' + lvl + '>')
      } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        flush()
        close()
        out.push('<hr>')
      } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flush()
        const kind = /^\s*\d/.test(line) ? 'ol' : 'ul'
        if (list !== kind) {
          close()
          out.push('<' + kind + '>')
          list = kind
        }
        out.push('<li>' + mdInline(m[1]) + '</li>')
      } else if (/^\s*$/.test(line)) {
        flush()
        close()
      } else {
        close()
        para.push(line.trim())
      }
    }
    flush()
    close()
    return out.join('\n')
  }

  // ------------------------------------------------------------ shared pieces
  function stat(label, value, cls) {
    const d = el('div', 'stat' + (cls && cls.includes('big') ? ' big' : ''))
    d.appendChild(el('dt', null, label))
    d.appendChild(el('dd', (cls || '').replace('big', '').trim() || null, value))
    return d
  }
  /** Inference vs tools split: bar plus legend with amounts and percentages. */
  function splitBar(llm, http) {
    llm = num(llm) || 0
    http = num(http) || 0
    const sum = llm + http
    const box = el('div', 'split')
    const bar = el('div', 'split-bar')
    bar.setAttribute('aria-hidden', 'true')
    ;[
      [llm, 'var(--llm)'],
      [http, 'var(--http)'],
    ].forEach(([v, c]) => {
      const d = el('span')
      d.style.width = (sum ? (v / sum) * 100 : 0).toFixed(1) + '%'
      d.style.background = c
      bar.appendChild(d)
    })
    const lg = el('ul', 'split-legend')
    ;[
      ['Inference', llm, 'var(--llm)'],
      ['Tools', http, 'var(--http)'],
    ].forEach(([l, v, c]) => {
      const li = el('li')
      const dot = el('span', 'dot')
      dot.style.background = c
      add(li, dot, l + ' ', el('b', 'money', fmtUsd(v)), ' (' + pct(v, sum) + '%)')
      lg.appendChild(li)
    })
    return add(box, bar, lg)
  }

  // ------------------------------------------------------------ index
  function thumbFor(r) {
    const media = (r.media || []).filter((m) => m.path)
    const video = media.find((m) => m.kind === 'video')
    const audio = media.find((m) => m.kind === 'audio')
    const th = el('div', 'thumb')
    if (r.thumb) {
      const img = el('img')
      img.src = r.thumb
      img.alt =
        video && video.poster === r.thumb
          ? 'Frame from the video the agent generated'
          : 'Image the agent generated'
      img.loading = 'lazy'
      th.appendChild(img)
      if (video && video.poster === r.thumb) {
        const b = el('span', 'thumb-badge')
        b.appendChild(el('span', 'play'))
        add(b, 'Video')
        th.appendChild(b)
      }
    } else if (video) {
      th.classList.add('thumb-video')
      const b = el('span', 'thumb-badge')
      add(b, el('span', 'play'), 'Video the agent generated')
      th.appendChild(b)
    } else if (audio) {
      th.classList.add('thumb-audio')
      const w = el('div', 'wave')
      w.setAttribute('aria-hidden', 'true')
      ;[18, 34, 50, 28, 44, 56, 30, 40, 22, 48, 36, 20, 42, 26, 16].forEach((h) => {
        const s = el('span')
        s.style.height = h + 'px'
        w.appendChild(s)
      })
      th.appendChild(w)
      th.appendChild(el('span', 'thumb-badge', '♪ Audio the agent generated'))
    } else {
      th.classList.add('thumb-empty')
      const e = el('span', 'thumb-emoji', r.emoji || '🤖')
      e.setAttribute('aria-hidden', 'true')
      th.appendChild(e)
    }
    return th
  }

  async function pageIndex() {
    const totals = $('totals'),
      grid = $('cards')
    let idx
    try {
      idx = await data.index()
    } catch (e) {
      return fail(totals, 'Could not load runs: ' + e.message)
    }
    const t = idx.totals || {}
    totals.textContent = ''
    const dl = el('dl', 'stats')
    dl.appendChild(stat('Total spent', fmtUsd(t.spentUsd), 'money'))
    dl.appendChild(stat('Runs', String(t.runs ?? '—'), 'num'))
    dl.appendChild(stat('Payments', String(t.payments ?? '—'), 'num'))
    dl.appendChild(stat('Paid services', String((t.topServices || []).length), 'num'))
    totals.appendChild(dl)
    totals.appendChild(splitBar(t.byKind && t.byKind.llm, t.byKind && t.byKind.http))
    if (LIVE) totals.appendChild(verifyWalletAction())
    if (LIVE && !(idx.runs || []).length)
      grid.appendChild(el('li', 'muted', 'No runs yet. Start one from Try it.'))

    ;(idx.runs || []).forEach((r) => {
      const li = el('li')
      const a = el('a', 'panel run-card')
      a.href = 'run.html?id=' + encodeURIComponent(r.id)
      a.appendChild(thumbFor(r))
      const b = el('div', 'run-body')
      const h = el('h3', 'run-title')
      if (r.emoji) {
        const e = el('span', 'emoji', r.emoji)
        e.setAttribute('aria-hidden', 'true')
        h.appendChild(e)
      }
      add(h, str(r.title))
      b.appendChild(h)
      if (LIVE) {
        // History: status and mode for every local run
        const meta = el('p', 'run-labels')
        add(
          meta,
          statusTag(r.status),
          el(
            'span',
            'tag',
            r.hints === false
              ? 'pure discovery'
              : r.hints === true
                ? '🧭 tool map'
                : 'mode unknown',
          ),
          el('span', 'dim', fmtDate(r.startedAt)),
        )
        b.appendChild(meta)
      }
      b.appendChild(el('p', 'run-task', str(r.task)))
      const foot = el('div', 'run-foot')
      const kv = (k, v, cls) =>
        add(foot, add(el('span', cls || null), el('b', 'money', v), ' ' + k))
      kv('spent', fmtUsd(r.spentUsd), 'spent')
      kv(r.payments === 1 ? 'payment' : 'payments', String(r.payments ?? '—'))
      kv(r.toolServices === 1 ? 'paid tool' : 'paid tools', String(r.toolServices ?? '—'))
      const tags = el('span', 'tags')
      ;[...new Set((r.media || []).filter((m) => m.path).map((m) => str(m.kind)))].forEach((k) =>
        tags.appendChild(el('span', 'tag', k)),
      )
      if (tags.childNodes.length) foot.appendChild(tags)
      b.appendChild(foot)
      a.appendChild(b)
      li.appendChild(a)
      grid.appendChild(li)
    })
  }

  function runYourself() {
    const box = $('run-yourself')
    if (!box) return
    box.hidden = false
    const h = el('h2', null, 'Run it yourself')
    h.id = 'ry-title'
    box.appendChild(h)
    box.appendChild(
      el(
        'p',
        null,
        'Paste the setup skill into Claude Code. It downloads the example, asks your Tempo Wallet to approve a capped key for the agent, and starts the app on your laptop.',
      ),
    )
    const row = el('div', 'copy-row')
    const btn = el('button', 'btn btn-primary copy-btn', 'Copy setup skill')
    btn.type = 'button'
    const status = el('span', 'copy-status')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    btn.addEventListener('click', async () => {
      status.className = 'copy-status'
      status.textContent = 'Copying…'
      try {
        await navigator.clipboard.writeText(await data.skill())
        status.className = 'copy-status ok'
        status.textContent = '✓ Copied. Paste it into Claude Code.'
      } catch (e) {
        status.className = 'copy-status err'
        status.textContent =
          'Could not copy (' +
          (e && e.message ? e.message : e) +
          '). Open SKILL.md and copy it by hand.'
      }
    })
    add(row, btn, status)
    box.appendChild(row)
    const links = el('p', 'links')
    add(links, link(REPO_URL, 'Source code'))
    box.appendChild(links)
  }

  // ------------------------------------------------------------ run page: call model
  // A CallLog folds the event stream into calls + interstitial thoughts. It works the same for a recorded
  // run (feed every event at once) and a live stream (feed events as they arrive).
  // A wait_for job (job.waiting / job.finished events, newer runs only) is one timeline row numbered like a call.
  // Its polls and result fetch (call.started with jobId) are folded into it, not listed; they still count in
  // calls (so totals, receipt and verification include their payments), with parentN pointing at the job row.
  function createCallLog() {
    const calls = new Map(),
      jobs = new Map(),
      order = []
    let n = 0
    function jobFor(jobId) {
      let j = jobs.get(jobId)
      if (!j) {
        j = { n: ++n, jobId, polls: [], result: null, waiting: null, finished: null, isJob: true }
        jobs.set(jobId, j)
        order.push({ job: j })
        j.isNew = true
      }
      return j
    }
    const jobRes = (j) => {
      const kind = j.isNew ? 'job' : 'jobUpdate'
      j.isNew = false
      return { kind, job: j }
    }
    /** Apply one event. Returns { kind: 'call' | 'update' | 'thought' | 'job' | 'jobUpdate', call?, thought?, job? } or null. */
    function apply(ev) {
      const id = str(ev.callId)
      if (ev.type === 'job.waiting' || ev.type === 'job.finished') {
        const j = jobFor(str(ev.jobId))
        if (ev.type === 'job.waiting') {
          j.waiting = ev
          if (!j.started) j.started = ev
        } else j.finished = ev
        const sub = calls.get(str(ev.callId))
        if (sub && sub.n != null) j.submitN = sub.n
        return jobRes(j)
      }
      if (ev.type === 'call.started') {
        if (ev.jobId) {
          // a poll or the result fetch of a wait_for job
          const j = jobFor(str(ev.jobId))
          const c = { ...ev, parentN: j.n }
          calls.set(id, c)
          if (ev.role === 'result') j.result = c
          else j.polls.push(c)
          return jobRes(j)
        }
        const c = { n: ++n, ...ev }
        calls.set(id, c)
        order.push({ call: c })
        return { kind: 'call', call: c }
      }
      if (ev.type === 'agent.thought') {
        order.push({ thought: ev })
        return { kind: 'thought', thought: ev }
      }
      if (!calls.has(id)) return null
      const c = calls.get(id)
      if (ev.type === 'call.challenge') c.challenge = ev
      else if (ev.type === 'call.policy') c.policy = ev
      else if (ev.type === 'call.paid') c.paid = ev
      else if (ev.type === 'call.finished') c.finished = ev
      else return null
      return c.jobId && jobs.has(str(c.jobId))
        ? jobRes(jobs.get(str(c.jobId)))
        : { kind: 'update', call: c }
    }
    return { apply, calls, jobs, order, list: () => [...calls.values()] }
  }
  const isBlocked = (c) =>
    (c.policy && c.policy.decision === 'deny') || (c.finished && c.finished.status === 'blocked')
  const statusOf = (c) =>
    isBlocked(c) ? 'blocked' : str(c.finished && c.finished.status) || (c.paid ? 'paid' : 'pending')

  // Plain-language "why" from the server's error body (FastAPI detail[], {error:{message}}, {message}, problem+json).
  function explainError(text) {
    const raw = str(text).trim()
    try {
      const j = JSON.parse(raw)
      if (Array.isArray(j.detail))
        return j.detail
          .slice(0, 3)
          .map((d) => {
            const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
            return (
              (field ? field + ': ' : '') +
              (d.msg || '') +
              (d.input != null ? ' (got "' + String(d.input).slice(0, 40) + '")' : '')
            )
          })
          .join('; ')
      const m = (j.error && (j.error.message || j.error)) || j.message || j.detail || j.title
      if (typeof m === 'string') return m
    } catch {
      /* not JSON */
    }
    return raw.slice(0, 200) || 'no error details returned'
  }
  const explain = (t) => explainError(t).replace(/[.\s]+$/, '') // no doubled period when we append text

  /** Plain-language reason for failed / paid_failed / blocked calls, or null. */
  function failureReason(c, status) {
    const f = c.finished || {}
    const code = f.httpStatus ? 'HTTP ' + f.httpStatus : 'no response'
    if (isBlocked(c))
      return (
        'Blocked by the harness before paying: ' +
        str((c.policy && c.policy.reason) || f.responseExcerpt || 'policy') +
        '. No charge.'
      )
    if (status === 'paid_failed')
      return (
        'Paid ' +
        fmtUsd(c.paid ? c.paid.chargedUsd : c.challenge && c.challenge.quotedUsd) +
        ', then the server rejected the request (' +
        code +
        '): ' +
        explain(f.responseExcerpt) +
        '. This endpoint charges before it validates the request, so the payment was not refunded.'
      )
    if (status === 'failed') {
      const ex = str(f.responseExcerpt)
      if (/parse URL from undefined/i.test(ex))
        return 'Failed: the agent sent an http call without a URL (a malformed tool call), so nothing was sent. No charge.'
      if (!f.httpStatus)
        return (
          'Failed: the request never reached a server (' +
          (ex || 'network error') +
          '), usually a dead or unreachable host. No charge.'
        )
      return 'Failed (' + code + '): ' + explain(ex) + '. No charge.'
    }
    return null
  }
  function kindIcon(c, status) {
    if (isBlocked(c)) return ['⛔', 'Blocked by policy']
    if (status === 'failed' || status === 'paid_failed')
      return ['⛔', status === 'paid_failed' ? 'Paid, then failed' : 'Failed']
    if (c.kind === 'llm') return ['🧠', 'LLM inference (paid)']
    if (c.challenge || c.paid) return ['💸', 'Paid HTTP']
    return ['🔎', 'Free HTTP']
  }
  const STATUS_LABEL = {
    paid: 'paid',
    free: 'free',
    failed: 'failed',
    paid_failed: 'paid · failed',
    blocked: 'blocked',
    pending: 'pending',
    unknown: 'unknown',
  }

  /** Paid tool services in the order the agent first used them (LLM inference excluded). */
  function toolsUsed(calls) {
    const byHost = new Map()
    calls.forEach((c) => {
      if (c.kind === 'llm' || !c.paid) return
      const sp = splitUrl(c.url, c.host),
        host = sp.host || 'unknown'
      const t = byHost.get(host) || {
        host,
        first: c.n ?? c.parentN,
        calls: 0,
        spent: 0,
        failed: 0,
        paths: [],
      }
      t.calls++
      t.spent += num(c.paid.chargedUsd) || 0
      if (statusOf(c) === 'paid_failed') t.failed++
      const p = sp.path.split('?')[0]
      if (!t.paths.includes(p)) t.paths.push(p)
      byHost.set(host, t)
    })
    return [...byHost.values()]
  }

  // ------------------------------------------------------------ run page: views
  // Each view owns a DOM node and exposes update methods, so a live stream can drive them incrementally.
  function kv(dl, k, v, cls) {
    dl.appendChild(el('dt', null, k))
    const dd = el('dd', cls || null)
    if (v instanceof Node) dd.appendChild(v)
    else dd.textContent = v == null || v === '' ? '—' : str(v)
    dl.appendChild(dd)
  }
  function section(title, wide) {
    const s = el('section', 'detail-section' + (wide ? ' wide' : ''))
    s.appendChild(el('h3', null, title))
    return s
  }
  function detail(c, why) {
    const grid = el('div', 'detail')
    if (why) {
      const w = el('p', 'why-box')
      add(w, el('strong', null, 'Why: '), why)
      grid.appendChild(w)
    }
    const req = section('Request')
    const d1 = el('dl')
    kv(d1, 'kind', c.kind)
    kv(d1, 'step', c.step)
    kv(d1, 'url', str(c.method) + ' ' + str(c.url), 'mono')
    if (c.reason) kv(d1, 'reason', c.reason)
    req.appendChild(d1)
    if (c.requestExcerpt) req.appendChild(el('pre', 'excerpt', str(c.requestExcerpt)))
    grid.appendChild(req)

    const ch = section('Payment challenge (402, decoded)')
    if (c.challenge) {
      const x = c.challenge,
        dl = el('dl'),
        cur = str(x.currency)
      kv(dl, 'quoted', fmtUsd(x.quotedUsd), 'money')
      kv(
        dl,
        'currency',
        (TOKENS[cur.toLowerCase()] ? TOKENS[cur.toLowerCase()] + '  ' : '') + cur,
        'mono',
      )
      kv(dl, 'chain', str(x.chainId) + (CHAINS[x.chainId] ? ' · ' + CHAINS[x.chainId] : ''))
      kv(dl, 'recipient', x.recipient, 'mono')
      kv(
        dl,
        'fee payer',
        typeof x.feePayer === 'boolean'
          ? x.feePayer
            ? 'sponsored by server'
            : 'client pays gas'
          : str(x.feePayer),
      )
      ch.appendChild(dl)
    } else ch.appendChild(el('p', 'muted', 'No challenge: free response.'))
    grid.appendChild(ch)

    const pol = section('Policy decision')
    if (c.policy) {
      const dl = el('dl')
      const dec = str(c.policy.decision)
      kv(dl, 'decision', el('span', 'status s-' + (dec === 'deny' ? 'deny' : 'allow'), dec))
      kv(dl, 'reason', c.policy.reason)
      pol.appendChild(dl)
    } else
      pol.appendChild(
        el(
          'p',
          'muted',
          c.finished && /blocked|failed/.test(str(c.finished.status))
            ? str(c.finished.responseExcerpt)
            : 'Not evaluated (nothing to pay).',
        ),
      )
    grid.appendChild(pol)

    const pay = section('Payment')
    if (c.paid) {
      const dl = el('dl')
      kv(dl, 'charged', fmtUsd(c.paid.chargedUsd), 'money')
      if (c.challenge) kv(dl, 'quoted', fmtUsd(c.challenge.quotedUsd), 'money')
      const box = el('div', 'tx-list')
      ;(c.paid.txHashes || []).forEach((h) => box.appendChild(txLink(h, true)))
      kv(dl, 'tx hash', box)
      pay.appendChild(dl)
    } else
      pay.appendChild(
        el('p', 'muted', isBlocked(c) ? 'Not paid: blocked by policy.' : 'No payment.'),
      )
    grid.appendChild(pay)

    const res = section('Response', true)
    if (c.finished) {
      const f = c.finished,
        dl = el('dl')
      kv(dl, 'status', str(f.status) + (f.httpStatus != null ? ' · HTTP ' + f.httpStatus : ''))
      kv(
        dl,
        'latency',
        num(f.latencyMs) == null ? '—' : Math.round(f.latencyMs).toLocaleString() + ' ms',
        'num',
      )
      kv(
        dl,
        'size',
        num(f.responseBytes) == null ? '—' : f.responseBytes.toLocaleString() + ' bytes',
        'num',
      )
      res.appendChild(dl)
      if (f.responseExcerpt) res.appendChild(el('pre', 'excerpt', str(f.responseExcerpt)))
    } else res.appendChild(el('p', 'muted', 'No response yet.'))
    grid.appendChild(res)
    return grid
  }

  const COLS = 7
  /** One timeline call: a summary row plus a hidden detail row. update() re-renders it in place from c. */
  function createCallRow(c) {
    const r = el('tr', 'call-row')
    r.id = 'call-' + c.n
    const detailId = 'call-' + c.n + '-detail'
    const numTd = el('td', 'c-num')
    const btn = el('button', 'row-toggle')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', detailId)
    add(btn, el('span', 'chev'), el('span', null, String(c.n)))
    numTd.appendChild(btn)
    const cells = el('td') // placeholder, replaced on first update
    add(r, numTd, cells)

    const d = el('tr', 'detail-row')
    d.id = detailId
    d.hidden = true
    const td = el('td')
    td.colSpan = COLS
    d.appendChild(td)

    let why = null
    const isOpen = () => !d.hidden
    const label = () =>
      btn.setAttribute(
        'aria-label',
        'Call ' + c.n + ': ' + (isOpen() ? 'hide' : 'show') + ' details',
      )
    function setOpen(open) {
      if (open && !td.firstChild) td.appendChild(detail(c, why))
      d.hidden = !open
      r.classList.toggle('expanded', open)
      btn.setAttribute('aria-expanded', String(open))
      label()
    }
    function update() {
      const s = statusOf(c)
      why = failureReason(c, s)
      r.className =
        'call-row' +
        (c.kind === 'llm' ? ' is-llm' : '') +
        (why ? ' is-bad' : '') +
        (isOpen() ? ' expanded' : '')
      while (r.lastChild !== numTd) r.removeChild(r.lastChild)

      const [icon, iconTitle] = kindIcon(c, s)
      const k = el('td', 'c-kind')
      const ic = el('span', null, icon)
      ic.title = iconTitle
      ic.setAttribute('role', 'img')
      ic.setAttribute('aria-label', iconTitle)
      k.appendChild(ic)

      const call = el('td', 'c-call')
      const sp = splitUrl(c.url, c.host)
      const line = el('span', 'call-line')
      line.title = str(c.method) + ' ' + str(c.url)
      add(
        line,
        el('span', 'method', str(c.method) || '…'),
        el('span', 'host', sp.host),
        el('span', 'path', truncPath(sp.path)),
      )
      add(
        call,
        line,
        el(
          'span',
          'reason' + (c.reason ? '' : ' none'),
          c.reason ? str(c.reason) : 'no reason given',
        ),
      )

      const q = c.challenge ? num(c.challenge.quotedUsd) : null
      const quoted = el(
        'td',
        'c-money c-quoted money' + (q == null ? ' dim' : ''),
        q == null ? '—' : fmtUsd(q),
      )
      const free = c.finished && c.finished.status === 'free'
      const under = c.paid && q != null && c.paid.chargedUsd < q
      const charged = el(
        'td',
        'c-money c-charged money' + (c.paid ? (under ? ' under' : '') : free ? ' free' : ' dim'),
        c.paid ? fmtUsd(c.paid.chargedUsd) : free ? 'free' : '—',
      )
      if (under) charged.title = 'Charged less than quoted'

      const st = el('td', 'c-status')
      const badge = el('span', 'status s-' + s, STATUS_LABEL[s] || s.replace('_', ' '))
      if (why) {
        const tipId = 'call-' + c.n + '-why'
        badge.classList.add('has-why')
        badge.tabIndex = 0
        badge.setAttribute('aria-describedby', tipId)
        const i = el('i', 'why-i', '?')
        i.setAttribute('aria-hidden', 'true')
        const tip = el('span', 'tip', why)
        tip.id = tipId
        tip.setAttribute('role', 'tooltip')
        add(badge, i, tip)
      }
      st.appendChild(badge)

      const tx = el('td', 'c-tx')
      const hashes = (c.paid && c.paid.txHashes) || []
      if (hashes.length) {
        const box = el('div', 'tx-list')
        hashes.forEach((h) => box.appendChild(txLink(h)))
        tx.appendChild(box)
      }
      add(r, k, call, quoted, charged, st, tx)

      if (td.firstChild) {
        td.textContent = ''
        if (isOpen()) td.appendChild(detail(c, why))
      }
      label()
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      setOpen(!isOpen())
    })
    r.addEventListener('click', (e) => {
      if (!e.target.closest('a, button, .tip')) setOpen(!isOpen())
    })
    update()
    return {
      call: c,
      row: r,
      detailRow: d,
      update,
      setOpen,
      focus: () => btn.focus({ preventScroll: true }),
    }
  }

  // ------------------------------------------------------------ run page: wait_for jobs
  const JOB_LABEL = {
    waiting: 'waiting',
    completed: 'done',
    failed: 'failed',
    timeout: 'timed out',
    stopped: 'stopped',
    blocked: 'blocked',
    poll_cap: 'poll cap',
  }
  const JOB_BAD = { failed: 1, timeout: 1, blocked: 1, poll_cap: 1 }
  const jobState = (j) => str(j.finished && j.finished.outcome) || 'waiting'
  const jobLatest = (j) => j.finished || j.waiting || {}
  const fmtSecs = (ms) => fmtDur(Math.round((num(ms) || 0) / 1000))
  const jobCalls = (j) => j.polls.concat(j.result ? [j.result] : [])
  /** "waiting… 45s · 7 polls" while running, "done in 1m 5s · 13 polls · status COMPLETED" once finished. */
  function jobProgress(j) {
    const x = jobLatest(j),
      polls = num(x.polls) ?? j.polls.length,
      st = jobState(j)
    const parts = [
      st === 'waiting'
        ? 'waiting… ' + fmtSecs(x.elapsedMs)
        : (JOB_LABEL[st] || st) + ' in ' + fmtSecs(x.elapsedMs),
      plural(polls, 'poll'),
    ]
    if (num(x.paidPolls)) parts.push(x.paidPolls + ' paid')
    if (x.status) parts.push('status ' + str(x.status))
    return parts.join(' · ')
  }
  function jobDetail(j, why) {
    const grid = el('div', 'detail')
    if (why) {
      const w = el('p', 'why-box')
      add(w, el('strong', null, 'Why: '), why)
      grid.appendChild(w)
    }
    const s0 = j.started || j.waiting || {},
      x = jobLatest(j)
    const job = section('Job (wait_for)', true),
      dl = el('dl')
    kv(dl, 'polls', str(s0.url) || (j.polls[0] && str(j.polls[0].url)), 'mono')
    if (s0.until)
      kv(
        dl,
        'until',
        str(s0.until.field) +
          ' in [' +
          (Array.isArray(s0.until.in) ? s0.until.in.join(', ') : '') +
          ']',
        'mono',
      )
    else kv(dl, 'until', 'the URL stops answering HTTP 202')
    if (s0.then) kv(dl, 'then', str(s0.then), 'mono')
    kv(
      dl,
      'interval',
      num(s0.every_s) == null ? '—' : s0.every_s + 's · timeout ' + fmtDur(s0.timeout_s),
    )
    if (j.submitN) kv(dl, 'submitted by', 'call #' + j.submitN)
    if (s0.reason) kv(dl, 'reason', s0.reason)
    kv(dl, 'progress', jobProgress(j))
    if (j.finished) kv(dl, 'outcome', str(j.finished.message))
    kv(dl, 'job spend', fmtUsd(num(x.spentUsd) ?? 0), 'money')
    job.appendChild(dl)
    grid.appendChild(job)

    const pl = section('Polls (' + j.polls.length + ')', true)
    if (j.polls.length) {
      const t = el('table', 'poll-table'),
        hb = el('tr')
      ;['#', 'HTTP', 'Result', 'Charged', 'Latency'].forEach((h) => {
        const th = el('th', null, h)
        th.scope = 'col'
        hb.appendChild(th)
      })
      add(t, add(el('thead'), hb))
      const tb = el('tbody')
      j.polls.forEach((c) => {
        const f = c.finished || {},
          tr = el('tr')
        add(
          tr,
          el('td', 'num', str(c.poll)),
          el('td', 'num', f.httpStatus != null ? String(f.httpStatus) : '…'),
          el('td', null, statusOf(c).replace('_', ' ')),
          el(
            'td',
            'money',
            c.paid ? fmtUsd(c.paid.chargedUsd) : f.status === 'free' ? 'free' : '—',
          ),
          el('td', 'num', num(f.latencyMs) == null ? '—' : Math.round(f.latencyMs) + ' ms'),
        )
        tb.appendChild(tr)
      })
      t.appendChild(tb)
      pl.appendChild(add(el('div', 'poll-table-wrap'), t))
    } else pl.appendChild(el('p', 'muted', 'No polls yet.'))
    grid.appendChild(pl)

    const res = section(j.result ? 'Result (GET then)' : 'Last response', true)
    const rc = j.result || j.polls[j.polls.length - 1],
      f = rc && rc.finished
    if (f) {
      const d2 = el('dl')
      kv(d2, 'url', str(rc.method) + ' ' + str(rc.url), 'mono')
      kv(d2, 'status', str(f.status) + (f.httpStatus != null ? ' · HTTP ' + f.httpStatus : ''))
      res.appendChild(d2)
      if (f.responseExcerpt) res.appendChild(el('pre', 'excerpt', str(f.responseExcerpt)))
    } else res.appendChild(el('p', 'muted', 'No response yet.'))
    grid.appendChild(res)
    return grid
  }
  /** One timeline row per wait_for job; same shape and toggling as createCallRow. */
  function createJobRow(j) {
    const r = el('tr', 'call-row job-row')
    r.id = 'call-' + j.n
    const detailId = 'call-' + j.n + '-detail'
    const numTd = el('td', 'c-num'),
      btn = el('button', 'row-toggle')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', detailId)
    add(btn, el('span', 'chev'), el('span', null, String(j.n)))
    numTd.appendChild(btn)
    r.appendChild(numTd)
    const d = el('tr', 'detail-row'),
      td = el('td')
    d.id = detailId
    d.hidden = true
    td.colSpan = COLS
    d.appendChild(td)
    let why = null
    const isOpen = () => !d.hidden
    const label = () =>
      btn.setAttribute(
        'aria-label',
        'Job ' + j.n + ': ' + (isOpen() ? 'hide' : 'show') + ' details',
      )
    function setOpen(open) {
      if (open && !td.firstChild) td.appendChild(jobDetail(j, why))
      d.hidden = !open
      r.classList.toggle('expanded', open)
      btn.setAttribute('aria-expanded', String(open))
      label()
    }
    function update() {
      const st = jobState(j),
        subs = jobCalls(j),
        s0 = j.started || j.waiting || {}
      why = JOB_BAD[st] && j.finished ? str(j.finished.message) : null
      r.className = 'call-row job-row' + (why ? ' is-bad' : '') + (isOpen() ? ' expanded' : '')
      while (r.lastChild !== numTd) r.removeChild(r.lastChild)
      const k = el('td', 'c-kind'),
        ic = el('span', null, why ? '⛔' : '⏳'),
        title = why ? 'Async job failed' : 'Async job (wait_for)'
      ic.title = title
      ic.setAttribute('role', 'img')
      ic.setAttribute('aria-label', title)
      k.appendChild(ic)
      const call = el('td', 'c-call'),
        sp = splitUrl(s0.url || (j.polls[0] && j.polls[0].url), '')
      const line = el('span', 'call-line')
      line.title = 'wait_for ' + str(s0.url)
      add(
        line,
        el('span', 'method', 'WAIT'),
        el('span', 'host', sp.host),
        el('span', 'path', truncPath(sp.path)),
      )
      const reason =
        str(s0.reason) + (j.submitN ? (s0.reason ? ' · ' : '') + 'for call #' + j.submitN : '')
      add(
        call,
        line,
        el('span', 'reason' + (reason ? '' : ' none'), reason || 'no reason given'),
        el('span', 'job-progress' + (st === 'waiting' ? ' pulse' : ''), jobProgress(j)),
      )
      const quotes = subs.filter((c) => c.challenge),
        paid = subs.filter((c) => c.paid)
      const qSum = quotes.reduce((a, c) => a + (num(c.challenge.quotedUsd) || 0), 0),
        cSum = paid.reduce((a, c) => a + (num(c.paid.chargedUsd) || 0), 0)
      const anyFree = subs.some((c) => c.finished && c.finished.status === 'free')
      const quoted = el(
        'td',
        'c-money c-quoted money' + (quotes.length ? '' : ' dim'),
        quotes.length ? fmtUsd(qSum) : '—',
      )
      const charged = el(
        'td',
        'c-money c-charged money' + (paid.length ? '' : anyFree ? ' free' : ' dim'),
        paid.length ? fmtUsd(cSum) : anyFree ? 'free' : '—',
      )
      if (paid.length) charged.title = plural(paid.length, 'paid call') + ' in this job'
      const stTd = el('td', 'c-status'),
        badge = el(
          'span',
          'status s-' + (why ? 'failed' : st === 'completed' ? 'free' : 'pending'),
          JOB_LABEL[st] || st,
        )
      if (why) {
        const tipId = 'call-' + j.n + '-why',
          i = el('i', 'why-i', '?'),
          tip = el('span', 'tip', why)
        badge.classList.add('has-why')
        badge.tabIndex = 0
        badge.setAttribute('aria-describedby', tipId)
        i.setAttribute('aria-hidden', 'true')
        tip.id = tipId
        tip.setAttribute('role', 'tooltip')
        add(badge, i, tip)
      }
      stTd.appendChild(badge)
      const tx = el('td', 'c-tx'),
        hashes = paid.flatMap((c) => c.paid.txHashes || [])
      if (hashes.length) {
        const box = el('div', 'tx-list')
        hashes.forEach((h) => box.appendChild(txLink(h)))
        tx.appendChild(box)
      }
      add(r, k, call, quoted, charged, stTd, tx)
      if (td.firstChild) {
        td.textContent = ''
        if (isOpen()) td.appendChild(jobDetail(j, why))
      }
      label()
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      setOpen(!isOpen())
    })
    r.addEventListener('click', (e) => {
      if (!e.target.closest('a, button, .tip')) setOpen(!isOpen())
    })
    update()
    return {
      call: j,
      row: r,
      detailRow: d,
      update,
      setOpen,
      focus: () => btn.focus({ preventScroll: true }),
    }
  }

  /** "How it got there": the timeline table. Feed it CallLog results with add() / update(). */
  function createTimeline() {
    const sec = el('section', 'timeline-section')
    sec.setAttribute('aria-labelledby', 'tl-title')
    const head = el('div', 'section-head')
    const h = el('h2', null, 'How it got there')
    h.id = 'tl-title'
    add(
      head,
      h,
      el(
        'p',
        null,
        'Every call, in order. Select a row for the request, the decoded 402 challenge, the policy decision and the response.',
      ),
    )
    sec.appendChild(head)

    const table = el('table', 'timeline')
    const rows = new Map() // call.n -> row view
    const bar = el('div', 'tl-tools')
    const lbl = el('label')
    const cb = el('input')
    cb.type = 'checkbox'
    cb.checked = true
    cb.addEventListener('change', () => table.classList.toggle('hide-llm', !cb.checked))
    add(lbl, cb, 'Show LLM calls')
    const all = el('button', 'btn btn-sm', 'Expand all')
    all.type = 'button'
    all.setAttribute('aria-pressed', 'false')
    all.addEventListener('click', () => {
      const open = all.getAttribute('aria-pressed') !== 'true'
      rows.forEach((r) => r.setOpen(open))
      all.setAttribute('aria-pressed', String(open))
      all.textContent = open ? 'Collapse all' : 'Expand all'
    })
    const legend = el('span', 'tl-legend')
    legend.setAttribute('aria-hidden', 'true')
    ;['🧠 LLM', '💸 paid http', '🔎 free http', '⛔ blocked/failed'].forEach((x) =>
      legend.appendChild(el('span', null, x)),
    )
    add(bar, lbl, all, legend)
    sec.appendChild(bar)

    const wrap = el('div', 'panel timeline-wrap')
    const thead = el('thead'),
      hr = el('tr')
    ;[
      ['c-num', '#'],
      ['c-kind', ''],
      ['c-call', 'Call and reason'],
      ['c-money', 'Quoted'],
      ['c-money', 'Charged'],
      ['c-status', 'Status'],
      ['c-tx', 'Tx'],
    ].forEach(([c, t]) => {
      const th = el('th', c, t || null)
      th.scope = 'col'
      if (!t) th.appendChild(el('span', 'sr-only', 'Kind'))
      hr.appendChild(th)
    })
    thead.appendChild(hr)
    const body = el('tbody')
    add(table, thead, body)
    wrap.appendChild(table)
    sec.appendChild(wrap)

    function addCall(c) {
      const v = createCallRow(c)
      rows.set(c.n, v)
      add(body, v.row, v.detailRow)
      return v
    }
    function addThought(t) {
      const tr = el('tr', 'thought-row'),
        td = el('td')
      td.colSpan = COLS
      if (num(t.step) != null) td.appendChild(el('span', 'thought-step', 'step ' + t.step))
      td.appendChild(el('span', 'thought-text', str(t.text)))
      tr.appendChild(td)
      body.appendChild(tr)
    }
    /** Apply a CallLog.apply() result: append a call or thought, or re-render the call's row in place. */
    function apply(res) {
      if (!res) return
      if (res.kind === 'call') addCall(res.call)
      else if (res.kind === 'thought') addThought(res.thought)
      else if (res.kind === 'update' && rows.has(res.call.n)) rows.get(res.call.n).update()
      else if (res.kind === 'job') {
        const v = createJobRow(res.job)
        rows.set(res.job.n, v)
        add(body, v.row, v.detailRow)
      } else if (res.kind === 'jobUpdate' && rows.has(res.job.n)) rows.get(res.job.n).update()
    }
    function open(n, scroll) {
      const v = rows.get(+n)
      if (!v) return
      v.setOpen(true)
      if (scroll) {
        v.row.scrollIntoView({ block: 'center' })
        v.focus()
      }
    }
    return { el: sec, apply, addCall, addThought, open, rows }
  }

  /** Paid tools strip. update(calls) re-renders from the current calls. */
  function createToolsStrip() {
    const sec = el('section', 'tools-strip')
    sec.setAttribute('aria-labelledby', 'tools-title')
    const head = el('div', 'section-head')
    const h = el('h2', null, 'Paid tools used')
    h.id = 'tools-title'
    const sub = el('p')
    add(head, h, sub)
    const body = el('div')
    add(sec, head, body)
    function update(calls) {
      const tools = toolsUsed(calls)
      sub.textContent = tools.length
        ? 'In the order the agent first used them. Select one to jump to its call.'
        : ''
      body.textContent = ''
      if (!tools.length) {
        body.appendChild(el('p', 'tools-empty', 'No paid tools: this run only paid for inference.'))
        return
      }
      const ol = el('ol')
      tools.forEach((t, i) => {
        const li = el('li', 'tool-step')
        const a = el('a')
        a.href = '#call-' + t.first
        a.dataset.call = String(t.first)
        a.title = t.host + '\n' + t.paths.join('\n')
        const n = el('span', 'tool-n', String(i + 1))
        n.setAttribute('aria-hidden', 'true')
        const s = el('span', 'tool-sub')
        add(s, el('span', 'money', fmtUsd(t.spent)), el('span', null, plural(t.calls, 'call')))
        if (t.failed) s.appendChild(el('span', 'bad', t.failed + ' failed'))
        add(a, n, el('span', 'tool-host', t.host), s)
        li.appendChild(a)
        ol.appendChild(li)
      })
      body.appendChild(ol)
    }
    return { el: sec, update }
  }

  /** Receipt: spend by service and the total. update(totals) takes run.finished.totals (or a live equivalent). */
  function createReceipt() {
    const sec = el('section', 'panel receipt')
    sec.setAttribute('aria-labelledby', 'receipt-title')
    const h = el('h2', null, 'Receipt')
    h.id = 'receipt-title'
    const tab = el('table')
    const actions = el('div', 'receipt-actions')
    add(sec, h, tab, actions)
    function update(t) {
      t = t || {}
      tab.textContent = ''
      tab.appendChild(el('caption', 'sr-only', 'Spend by service'))
      const thead = el('thead'),
        hr = el('tr')
      ;['Service', 'Calls', 'Spent'].forEach((x, i) => {
        const th = el('th', i ? 'r' : null, x)
        th.scope = 'col'
        hr.appendChild(th)
      })
      thead.appendChild(hr)
      const body = el('tbody')
      Object.entries(t.byService || {})
        .sort((a, b) => b[1].spentUsd - a[1].spentUsd)
        .forEach(([host, x]) => {
          const tr = el('tr', x.spentUsd > 0 ? null : 'zero')
          add(
            tr,
            el('td', 'svc mono', host),
            el('td', 'r num', String(x.calls)),
            el('td', 'r money', fmtUsd(x.spentUsd)),
          )
          body.appendChild(tr)
        })
      const tf = el('tfoot'),
        fr = el('tr')
      const tot = el('td', 'r money', fmtUsd(t.spentUsd))
      tot.appendChild(el('span', 'pay-count', plural(num(t.payments) ?? 0, 'payment')))
      add(fr, el('td', null, 'Total'), el('td'), tot)
      tf.appendChild(fr)
      add(tab, thead, body, tf)
    }
    update({})
    return { el: sec, update, actions }
  }

  /** Cost summary (spent, payments, paid tools, calls, budget, split). update(summary). */
  function createSummary() {
    const sec = el('section', 'panel summary')
    function update(s) {
      s = s || {}
      sec.textContent = ''
      const dl = el('dl', 'stats')
      dl.appendChild(stat('Spent', fmtUsd(s.spentUsd), 'money big'))
      dl.appendChild(stat('Payments', String(s.payments ?? '—'), 'num'))
      dl.appendChild(stat('Paid tools', String(s.toolServices ?? '—'), 'num'))
      dl.appendChild(stat('Calls', String(s.calls ?? '—'), 'num'))
      if (s.budget) dl.appendChild(stat('Budget', fmtUsd(s.budget.totalUsd), 'money'))
      add(sec, dl, splitBar(s.byKind && s.byKind.llm, s.byKind && s.byKind.http))
    }
    update({})
    return { el: sec, update }
  }

  /** Final answer. set(markdown, media) renders it (escaped first, see renderMarkdown). */
  function createAnswer() {
    const sec = el('section', 'panel answer')
    sec.setAttribute('aria-labelledby', 'answer-title')
    const h = el('h2', null, 'Final answer')
    h.id = 'answer-title'
    const md = el('div', 'markdown')
    add(sec, h, md)
    function set(text, media) {
      POSTERS = {}
      ;(media || []).forEach((m) => {
        if (m && m.path && m.poster) POSTERS[m.path] = m.poster
      })
      setMarkdownHtml(md, renderMarkdown(text || '', 2))
      if (!md.childNodes.length) md.appendChild(el('p', 'muted', 'No final answer recorded.'))
    }
    function pending(text) {
      md.textContent = ''
      md.appendChild(el('p', 'muted pulse', text || 'The agent is still working…'))
    }
    return { el: sec, set, pending }
  }

  // ------------------------------------------------------------ run view (run page + Try it)
  const STATUS_TEXT = {
    done: 'done',
    stopped: 'stopped',
    budget: 'budget',
    max_steps: 'max steps',
    error: 'error',
    running: 'running',
    incomplete: 'incomplete',
  }
  function statusTag(status) {
    const s = str(status) || 'incomplete'
    return el('span', 'run-status rs-' + s.replace(/\W/g, ''), STATUS_TEXT[s] || s)
  }

  /** Totals derived from the events seen so far (mirrors runTotals in src/runview.ts); run.finished totals win. */
  function deriveTotals(events, log) {
    const fin = events.find((e) => e.type === 'run.finished')
    if (fin && fin.totals) return fin.totals
    const byService = {},
      byKind = { llm: 0, http: 0 }
    let payments = 0
    log.list().forEach((c) => {
      const s = (byService[str(c.host)] = byService[str(c.host)] || { calls: 0, spentUsd: 0 })
      s.calls++
      if (c.paid) {
        const v = num(c.paid.chargedUsd) || 0
        s.spentUsd += v
        byKind[c.kind === 'llm' ? 'llm' : 'http'] += v
        payments++
      }
    })
    return { spentUsd: byKind.llm + byKind.http, payments, byService, byKind }
  }

  /**
   * The body of a run: cost summary + receipt (side), paid tools, final answer and the timeline (main).
   * apply(ev) takes events one at a time, so a recorded run and a live SSE stream render through the same path.
   */
  function createRunView(opts) {
    opts = opts || {}
    const summary = createSummary(),
      receipt = createReceipt(),
      tools = createToolsStrip(),
      answer = createAnswer(),
      tl = createTimeline()
    const log = createCallLog(),
      events = []
    let started = null,
      base = opts.summary || {}
    const side = el('aside', 'run-side')
    side.setAttribute('aria-label', 'Cost summary')
    add(side, summary.el, receipt.el)
    const main = el('div', 'run-main')
    add(main, tools.el, answer.el, tl.el)

    function refresh() {
      const t = deriveTotals(events, log)
      const paidTools = Object.entries(t.byService || {}).filter(
        ([h, v]) => v.spentUsd > 0 && !h.startsWith('openrouter.'),
      ).length
      summary.update({
        spentUsd: t.spentUsd,
        payments: t.payments,
        byKind: t.byKind,
        toolServices: paidTools,
        calls: log.calls.size,
        budget: (started && started.budget) || base.budget,
      })
      receipt.update(t)
      tools.update(log.list())
    }
    function apply(ev, quiet) {
      events.push(ev)
      if (ev.type === 'run.started') started = ev
      tl.apply(log.apply(ev))
      if (ev.type === 'run.finished') answer.set(ev.answer, base.media)
      if (!quiet && opts.onEvent) opts.onEvent(ev)
      if (!quiet) refresh()
    }
    /** Render a whole recorded run (static or live data.run()). */
    function load(doc) {
      base = doc.summary || {}
      ;(doc.events || []).forEach((e) => apply(e, true))
      refresh()
      summary.update(base) // the exported summary is authoritative for the header numbers
      if (!events.some((e) => e.type === 'run.finished'))
        answer.pending(
          base.status === 'running' ? null : 'No final answer: the run ended without one.',
        )
    }
    // Jump-to-call links (tools strip, #call-N in the URL) open that row.
    main.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-call]')
      if (!a) return
      e.preventDefault()
      history.replaceState(null, '', '#call-' + a.dataset.call)
      tl.open(a.dataset.call, true)
    })
    answer.pending()
    refresh()
    return {
      side,
      main,
      apply,
      load,
      events,
      log,
      receipt,
      timeline: tl,
      answer,
      setBase: (s) => {
        base = s || base
      },
    }
  }

  // ------------------------------------------------------------ live-only: on-chain verification
  const fmtUsd6 = (v) => (num(v) == null ? '—' : '$' + v.toFixed(6))
  function verifyBox() {
    const b = el('div', 'verify')
    b.setAttribute('role', 'status')
    b.setAttribute('aria-live', 'polite')
    return b
  }
  function verifyHead(box, ok, text) {
    box.className = 'verify ' + (ok ? 'ok' : 'bad')
    box.appendChild(el('p', 'verify-head', text))
  }

  /** "Verify on-chain" for one run (live only; the static site never shows it). */
  function verifyRunAction(runId, log) {
    const wrap = el('div', 'verify-wrap')
    const btn = el('button', 'btn btn-sm', 'Verify on-chain')
    btn.type = 'button'
    const box = verifyBox()
    btn.addEventListener('click', async () => {
      btn.disabled = true
      box.className = 'verify pending'
      box.textContent = 'Verifying on-chain… fetching transaction receipts from Tempo'
      let v
      try {
        v = await live.verifyRun(runId)
      } catch (e) {
        box.textContent = ''
        verifyHead(box, false, 'Verification failed: ' + e.message)
        btn.disabled = false
        return
      }
      btn.disabled = false
      box.textContent = ''
      const pays = num(v.payments) ?? 0
      const callN = (id) => {
        const c = log.calls.get(str(id))
        return !c
          ? str(id)
          : c.n != null
            ? c.n
            : c.parentN +
              (c.role === 'result' ? ' (job result)' : ' (job poll ' + str(c.poll) + ')')
      }
      if (v.ok) {
        verifyHead(
          box,
          true,
          '✓ Reconciled: ' +
            plural(pays, 'payment') +
            ', ' +
            fmtUsd6(v.onchainUsd) +
            ', matches the chain',
        )
        box.appendChild(
          el(
            'p',
            'verify-line money',
            (num(v.txCount) ?? 0) +
              ' tx · reported ' +
              fmtUsd6(v.reportedUsd) +
              ' · on-chain ' +
              fmtUsd6(v.onchainUsd) +
              ' · Δ ' +
              fmtUsd6(v.deltaUsd),
          ),
        )
        return
      }
      verifyHead(
        box,
        false,
        '✗ Does not reconcile: on-chain ' +
          fmtUsd6(v.onchainUsd) +
          ' vs reported ' +
          fmtUsd6(v.reportedUsd) +
          ' (Δ ' +
          fmtUsd6(v.deltaUsd) +
          ')',
      )
      const ul = el('ul', 'verify-list')
      ;(Array.isArray(v.mismatches) ? v.mismatches : []).forEach((m) => {
        const li = el(
          'li',
          null,
          'Call #' +
            callN(m.callId) +
            ': reported ' +
            fmtUsd6(m.reported) +
            ', on-chain ' +
            fmtUsd6(m.onchain) +
            ' ',
        )
        ;(Array.isArray(m.txHashes) ? m.txHashes : []).forEach((h) => li.appendChild(txLink(h)))
        ul.appendChild(li)
      })
      ;(Array.isArray(v.missing) ? v.missing : []).forEach((m) => {
        const li = el('li', null, 'Call #' + callN(m.callId) + ': ' + str(m.reason) + ' ')
        if (m.txHash) li.appendChild(txLink(m.txHash))
        ul.appendChild(li)
      })
      box.appendChild(ul)
    })
    add(wrap, btn, box)
    return wrap
  }

  /** "Verify wallet" on the History totals (live only). */
  function verifyWalletAction() {
    const wrap = el('div', 'verify-wrap totals-verify')
    const btn = el('button', 'btn btn-sm', 'Verify wallet')
    btn.type = 'button'
    const box = verifyBox()
    btn.addEventListener('click', async () => {
      btn.disabled = true
      box.className = 'verify pending'
      box.textContent =
        'Verifying on-chain… checking every payment the runs recorded (local demo wallet: every transfer since it was funded)'
      let v
      try {
        v = await live.verifyWallet()
      } catch (e) {
        box.textContent = ''
        verifyHead(box, false, 'Verification failed: ' + e.message)
        btn.disabled = false
        return
      }
      btn.disabled = false
      box.textContent = ''
      const n = num(v.outboundTxCount) ?? 0,
        runsN = num(v.runs) ?? 0,
        scoped = v.scope === 'runs'
      verifyHead(
        box,
        !!v.ok,
        v.ok
          ? scoped
            ? '✓ Every run payment is on-chain: ' +
              fmtUsd6(v.onchainSpentUsd) +
              ' in ' +
              n +
              ' tx from your Tempo Wallet, matching ' +
              plural(runsN, 'run')
            : '✓ Every cent accounted for: ' +
              fmtUsd6(v.onchainSpentUsd) +
              ' left the wallet in ' +
              n +
              ' tx, matching ' +
              plural(runsN, 'run')
          : '✗ Wallet does not reconcile',
      )
      if (scoped) {
        box.appendChild(
          el(
            'p',
            'verify-line',
            'Your Tempo Wallet is yours: only payments this agent recorded are checked, not your other activity.',
          ),
        )
        if (v.allowance)
          box.appendChild(
            el(
              'p',
              'verify-line money',
              'This access key: used ' +
                fmtUsd6(v.allowance.usedUsd) +
                ' of ' +
                fmtUsd6(v.allowance.limitUsd) +
                ' (on-chain limit − remaining)',
            ),
          )
      } else
        box.appendChild(
          el(
            'p',
            'verify-line money',
            'Funded ' +
              fmtUsd6(v.fundedUsd) +
              ' − balance ' +
              fmtUsd6(v.balanceUsd) +
              ' = ' +
              fmtUsd6(v.fundedMinusBalanceUsd),
          ),
        )
      box.appendChild(
        el(
          'p',
          'verify-line money',
          'On-chain spend ' +
            fmtUsd6(v.onchainSpentUsd) +
            ' · sum of runs ' +
            fmtUsd6(v.runsReportedUsd),
        ),
      )
      if (v.fundingTx)
        box.appendChild(add(el('p', 'verify-line'), 'Funding tx ', txLink(v.fundingTx)))
      ;[
        ['Spent on-chain but not in any run', v.unattributed],
        ['In a run but not found on-chain', v.missing],
      ].forEach(([label, arr]) => {
        if (!Array.isArray(arr) || !arr.length) return
        box.appendChild(el('h3', 'verify-sub', label))
        const ul = el('ul', 'verify-list')
        arr.forEach((h) => ul.appendChild(add(el('li'), txLink(h))))
        box.appendChild(ul)
      })
    })
    add(wrap, btn, box)
    return wrap
  }

  // ------------------------------------------------------------ run page
  function runHeader(s, statusEl) {
    const head = el('header', 'run-head')
    const h1 = el('h1')
    if (s.emoji) {
      const e = el('span', 'emoji', s.emoji)
      e.setAttribute('aria-hidden', 'true')
      h1.appendChild(e)
    }
    add(h1, str(s.title))
    head.appendChild(h1)
    const meta = el('p', 'run-meta')
    if (statusEl) add(meta, statusEl, ' ')
    add(
      meta,
      [
        fmtDate(s.startedAt),
        fmtDur(s.durationSec),
        str(s.model),
        s.hints === true ? 'with tool map' : s.hints === false ? 'pure discovery' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )
    head.appendChild(meta)
    const fig = el('figure', 'prompt')
    add(fig, el('figcaption', 'eyebrow', 'Prompt'), el('blockquote', null, str(s.task)))
    head.appendChild(fig)
    return head
  }

  async function pageRun() {
    const root = $('run')
    const id = new URLSearchParams(location.search).get('id') || ''
    let idx, run
    try {
      ;[idx, run] = await Promise.all([data.index(), data.run(id)])
    } catch (e) {
      fail(root, 'Could not load this run (' + e.message + ').')
      return root.appendChild(add(el('p'), link('index.html', CONFIG.backToIndex)))
    }
    const s = run.summary || {}
    document.title = 'mpp-agent · ' + str(s.title)
    root.textContent = ''

    // Top bar: back to list + prev / next.
    const list = idx.runs || [],
      at = list.findIndex((r) => r.id === s.id)
    const prev = at > 0 ? list[at - 1] : null,
      next = at >= 0 && at < list.length - 1 ? list[at + 1] : null
    const runHref = (r) => 'run.html?id=' + enc(r.id)
    const top = el('nav', 'run-topbar')
    top.setAttribute('aria-label', 'Run navigation')
    top.appendChild(link('index.html', CONFIG.backToIndex))
    const pager = el('span', 'pager')
    if (prev) {
      const a = link(runHref(prev), '‹ ' + str(prev.title))
      a.rel = 'prev'
      pager.appendChild(a)
    } else pager.appendChild(el('span', 'off', '‹ Previous'))
    if (next) {
      const a = link(runHref(next), str(next.title) + ' ›')
      a.rel = 'next'
      pager.appendChild(a)
    } else pager.appendChild(el('span', 'off', 'Next ›'))
    top.appendChild(pager)
    root.appendChild(top)

    const status = LIVE && s.status !== 'done' ? statusTag(s.status) : null
    const view = createRunView({ summary: s })
    view.load(run)
    if (LIVE) view.receipt.actions.appendChild(verifyRunAction(s.id, view.log))

    const pb = el('nav', 'pager-bottom')
    pb.setAttribute('aria-label', 'More runs')
    const card = (r, cls, label) => {
      const a = link(runHref(r), null, 'panel ' + cls)
      add(
        a,
        el('span', 'eyebrow', label),
        el('span', 't', (r.emoji ? r.emoji + ' ' : '') + str(r.title)),
      )
      return a
    }
    if (prev) pb.appendChild(card(prev, 'prev', '‹ Previous run'))
    if (next) pb.appendChild(card(next, 'next', 'Next run ›'))
    if (prev || next) view.main.appendChild(pb)
    const layout = el('div', 'run-layout')
    add(layout, runHeader(s, status), view.side, view.main)
    root.appendChild(layout)

    const hm = /^#call-(\d+)$/.exec(location.hash)
    if (hm) view.timeline.open(hm[1], true)

    // Live: an in-progress run keeps streaming until it finishes.
    if (LIVE && s.status === 'running') {
      streamRun(
        s.id,
        (run.events || []).length,
        (ev) => {
          view.apply(ev)
          if (ev.type === 'run.finished') status.replaceWith(statusTag(ev.reason))
        },
        (st) => {
          if (st === 'reconnecting') status.textContent = 'reconnecting…'
        },
      )
    }
  }

  // ------------------------------------------------------------ Try it (live only)
  // [label, full prompt, optional budget]. The first five are always visible; the rest sit behind "More".
  // A chip budget is an allocation for that run (the server only lets it tighten the defaults).
  const SUGGESTED = [
    [
      '🎬 Make a viral video',
      "Research what's trending right now with a real search, write a short viral video concept, then generate the video.",
    ],
    [
      '🌤 Plan my Saturday in Lisbon',
      "I'm spending Saturday in Lisbon. Check the forecast, find three highly rated cafés near Praça do Comércio and one event this weekend, teach me how to order 'two coffees and the bill, please' in Portuguese, and finish with a postcard-style illustration of the day.",
    ],
    [
      '🎧 Tech brief I can listen to',
      'Give me a 60-second tech morning brief: the top 3 tech headlines today from a real news search, what people on X and Reddit are buzzing about, and one notable tech stock move. Then turn the brief into an audio clip I can play.',
    ],
    [
      '🏠 Is this house a good rental?',
      'Should I buy 2100 Vine St, Berkeley CA as a rental? Get its estimated value and market rent, compute the gross yield and a simple cap rate (35% expenses) by running code, check the air quality there, and give me a verdict with a numbers table.',
    ],
    [
      '👟 Should I flip these sneakers?',
      "Is a pair of Air Jordan 1 High 'Chicago' worth flipping right now? Pull current resale prices from two marketplaces, check what people say on Reddit and X this week, compute my profit after a 12% fee and $15 shipping in code, and give a buy/skip verdict.",
    ],
    [
      '💊 Semaglutide landscape',
      'Map the semaglutide landscape for a healthcare analyst: US drug products that contain it, late-stage trials that are recruiting, any recalls or safety notices, and the biggest related news this month. Use tables with source links.',
    ],
  ]
  const CHIPS_VISIBLE = 5
  const shortAddr = (a) => {
    a = str(a)
    return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a
  }

  async function pageTry() {
    const task = $('task'),
      runBtn = $('run-btn'),
      stopBtn = $('stop-btn'),
      hintsBox = $('hints-toggle'),
      subBox = $('subagents-toggle'),
      err = $('try-error')
    const chips = $('chips'),
      out = $('try-run'),
      runState = $('run-state'),
      bal = $('wallet-balance'),
      addr = $('wallet-address'),
      allow = $('wallet-allowance')
    let chipBudget = null,
      es = null,
      runId = null,
      shown = null

    function setBalance(v, animate) {
      v = num(v)
      if (v == null) return
      bal.textContent = fmtUsd(v)
      if (animate && shown != null && v < shown) {
        bal.classList.remove('tick')
        void bal.offsetWidth
        bal.classList.add('tick')
      }
      shown = v
    }
    /** Tempo Wallet mode: what the agent's access key may still spend. Runs and wallets without one carry no allowance fields. */
    function setAllowance(src) {
      const left = num(src.allowanceUsd),
        limit = num(src.allowanceLimitUsd)
      if (left == null) return
      const exp = src.allowanceExpiresAt ? new Date(str(src.allowanceExpiresAt)) : null
      allow.textContent =
        ' · Allowance ' +
        fmtUsd(left) +
        (limit != null ? ' of ' + fmtUsd(limit) : '') +
        (exp && !isNaN(exp)
          ? ' · expires ' + exp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '')
      allow.hidden = false
    }
    function showError(msg) {
      err.textContent = msg
      err.hidden = !msg
    }
    function setState(text, cls) {
      runState.textContent = ''
      if (text) runState.appendChild(el('span', 'run-status rs-' + (cls || 'running'), text))
    }

    // Chips fill the prompt box; they never auto-run.
    const extra = []
    SUGGESTED.forEach(([label, prompt, budget], i) => {
      const b = el('button', 'chip', label)
      b.type = 'button'
      b.title = prompt
      b.addEventListener('click', () => {
        task.value = prompt
        chipBudget = budget ? { prompt, budget } : null
        task.focus()
      })
      if (i >= CHIPS_VISIBLE) {
        b.hidden = true
        extra.push(b)
      }
      chips.appendChild(b)
    })
    if (extra.length) {
      const more = el('button', 'chip chip-more', 'More…')
      more.type = 'button'
      more.setAttribute('aria-expanded', 'false')
      more.addEventListener('click', () => {
        const open = more.getAttribute('aria-expanded') !== 'true'
        extra.forEach((b) => (b.hidden = !open))
        more.setAttribute('aria-expanded', String(open))
        more.textContent = open ? 'Less' : 'More…'
      })
      chips.appendChild(more)
    }

    /** Render a run (new or already active) as it streams. */
    function follow(id) {
      runId = id
      if (es) es.close()
      out.textContent = ''
      out.hidden = false
      const head = el('div', 'try-run-head')
      const h = el('h2', null, 'This run')
      const doneLink = el('span')
      add(head, h, doneLink)
      const view = createRunView({
        onEvent: (ev) => {
          if (ev.type === 'run.started' && !task.value.trim()) task.value = str(ev.task)
          if (ev.type === 'wallet.balance') {
            setBalance(ev.balanceUsd, true)
            setAllowance(ev)
          }
          if (ev.type === 'call.started' && !ev.jobId) setState('running · step ' + ev.step)
          if (ev.type === 'job.waiting')
            setState(
              'waiting for a job · ' +
                fmtSecs(ev.elapsedMs) +
                ' · ' +
                plural(num(ev.polls) ?? 0, 'poll'),
            )
          if (ev.type === 'job.finished') setState('running')
        },
      })
      const layout = el('div', 'run-layout try-layout')
      add(layout, head, view.side, view.main)
      out.appendChild(layout)
      runBtn.disabled = true
      stopBtn.disabled = false
      setState('starting…')
      es = streamRun(
        id,
        0,
        (ev) => {
          view.apply(ev)
          if (ev.type === 'run.finished') {
            setState(STATUS_TEXT[ev.reason] || str(ev.reason), str(ev.reason).replace(/\W/g, ''))
            doneLink.appendChild(link('run.html?id=' + enc(id), 'View in History →', 'btn btn-sm'))
            view.receipt.actions.appendChild(verifyRunAction(id, view.log))
            runBtn.disabled = false
            stopBtn.disabled = true
            live
              .wallet()
              .then((w) => {
                setBalance(w.balanceUsd, true)
                setAllowance(w)
              })
              .catch(() => {})
          }
        },
        (st) => {
          if (st === 'reconnecting') setState('reconnecting…', 'error')
          if (st === 'closed') {
            setState('disconnected', 'error')
            runBtn.disabled = false
            stopBtn.disabled = true
          }
        },
      )
    }

    async function start() {
      const t = task.value.trim()
      if (!t) {
        task.focus()
        return
      }
      showError('')
      runBtn.disabled = true
      try {
        const body = { task: t, hints: hintsBox.checked, subagents: subBox.checked }
        if (chipBudget && chipBudget.prompt === t) body.budget = chipBudget.budget
        const j = await live.start(body)
        if (!j || !j.runId) throw new Error('The server did not return a run id.')
        follow(str(j.runId))
      } catch (e) {
        runBtn.disabled = false
        showError(e.message)
      }
    }
    runBtn.addEventListener('click', start)
    task.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
    })
    stopBtn.addEventListener('click', async () => {
      if (!runId) return
      stopBtn.disabled = true
      setState('stopping…')
      try {
        await live.stop(runId)
      } catch (e) {
        showError('Stop failed: ' + e.message)
        stopBtn.disabled = false
      }
    })

    try {
      const w = await live.wallet()
      addr.textContent = shortAddr(w.address)
      addr.title =
        str(w.address) +
        (w.network ? ' · ' + w.network : '') +
        (w.accessKey ? ' · access key ' + str(w.accessKey) : '')
      if (w.mode === 'tempo-wallet') $('wallet-label').textContent = 'Tempo Wallet'
      else if (w.mode === 'legacy') $('wallet-label').textContent = 'Local demo wallet'
      setBalance(w.balanceUsd, false)
      setAllowance(w)
      if (w.activeRunId) follow(str(w.activeRunId)) // a run is already in progress: attach to it
    } catch (e) {
      showError('Could not reach the wallet (' + e.message + ').')
    }
  }

  // ------------------------------------------------------------ boot
  const page = document.body.dataset.page
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const label = CONFIG.nav[a.dataset.nav]
    if (!label) {
      a.remove()
      return
    } // e.g. "Try it" on the static site
    a.textContent = label
    a.hidden = false
    if (a.dataset.nav === page || (page === 'run' && a.dataset.nav === 'index'))
      a.setAttribute('aria-current', 'page')
  })
  if (LIVE) document.querySelectorAll('[data-static-only]').forEach((n) => n.remove())
  else document.querySelectorAll('[data-live-only]').forEach((n) => n.remove())
  if (page === 'index' && !LIVE) runYourself()
  const fn = { index: pageIndex, run: pageRun, try: LIVE ? pageTry : null }[page]
  if (fn)
    fn().catch((e) => {
      const m = $('main')
      if (m) fail(m, 'Something went wrong rendering this page (' + (e && e.message) + ').')
    })
})()
