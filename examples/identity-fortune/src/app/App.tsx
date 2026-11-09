import { File, MultiFileDiff } from '@pierre/diffs/react'
import { Receipt } from 'mppx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

import * as Client from '../client.js'
import * as Trace from '../trace.js'
import { Diagram, type NodeId, stepNode } from './Diagram.js'
import { type FileName, files, markers } from './sources.js'

type Config = { issuer: string; origin: string; prices: Record<string, string> }

/** Scrolls the step list, not the page, so the running step stays in view. */
function reveal(el: HTMLElement | null) {
  const list = el?.parentElement
  if (!el || !list) return
  if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop
  else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight
}

/** One HTTP hop the client made, with the steps the server reported for it. */
type Hop = {
  method: string
  url: string
  path: string
  status: number
  request: [string, string][]
  response: [string, string][]
  body?: string | undefined
  responseBody: string
}

type Step = { id: string; detail?: string | undefined; hop: number }

type Result = {
  tier: string
  price: string
  haiku: string[]
  model: string
  prompt: { system: string; user: string }
  seen: string[]
  receipt?: string | undefined
}

type PendingCode = {
  email: string
  id: string
  message?: { to: string; subject: string; text: string; code: string } | undefined
  resolve: (code: string | undefined) => void
}

const rpc = createClient({ chain: Chain.testnet, pollingInterval: 500, transport: http() })
const pathUsd = '0x20c0000000000000000000000000000000000000' as const
const explorer = 'https://explore.testnet.tempo.xyz'

function loadAccount() {
  let key = localStorage.getItem('fortune.key') as Hex | null
  if (!key) {
    key = generatePrivateKey()
    localStorage.setItem('fortune.key', key)
  }
  return privateKeyToAccount(key)
}

export function App() {
  const account = useMemo(loadAccount, [])
  const [config, setConfig] = useState<Config>()
  const [balance, setBalance] = useState<string>()
  const [funding, setFunding] = useState(true)
  const [emailOn, setEmailOn] = useState(false)
  const [email, setEmail] = useState('')
  const [keyOn, setKeyOn] = useState(false)
  const [apiKey, setApiKey] = useState('fortune-demo-key')
  const [hops, setHops] = useState<Hop[]>([])
  const [steps, setSteps] = useState<Step[]>([])
  const [cursor, setCursor] = useState(-1)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<Result>()
  const [pending, setPending] = useState<PendingCode>()
  const [code, setCode] = useState('')
  const [tab, setTab] = useState<FileName | 'usage' | 'prompt'>('client.ts')
  const [follow, setFollow] = useState(true)
  const [usage, setUsage] = useState({
    old: usageSource(false, false, ''),
    now: usageSource(false, false, ''),
  })
  const hopsRef = useRef<Hop[]>([])

  // Config and wallet.
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
    ;(async () => {
      try {
        await refreshBalance()
        if (Number(balanceRef.current ?? 0) < 0.5)
          await Actions.faucet.fundSync(rpc, { account, timeout: 30_000 })
        await refreshBalance()
      } catch (e) {
        setError(`Funding failed: ${String(e)}`)
      } finally {
        setFunding(false)
      }
    })()
  }, [])
  const balanceRef = useRef<string | undefined>(undefined)
  async function refreshBalance() {
    const value = await Actions.token.getBalance(rpc, { account, token: pathUsd })
    const formatted = (Number(value.amount) / 1e6).toFixed(2)
    balanceRef.current = formatted
    setBalance(formatted)
  }

  // The client code you'd write, as a diff against the last toggle.
  useEffect(() => {
    const now = usageSource(emailOn, keyOn, email)
    setUsage((previous) => (previous.now === now ? previous : { old: previous.now, now }))
    if (follow) setTab('usage')
  }, [emailOn, keyOn])

  // Plays the steps one at a time.
  useEffect(() => {
    if (paused || cursor >= steps.length - 1) return
    const timer = setTimeout(() => setCursor((c) => c + 1), cursor < 0 ? 0 : 750)
    return () => clearTimeout(timer)
  }, [cursor, steps.length, paused])

  const active = steps[cursor]
  const marker = active ? markers.get(active.id) : undefined
  useEffect(() => {
    if (follow && marker) setTab(marker.file)
  }, [active?.id, active?.hop])

  function addSteps(next: Omit<Step, 'hop'>[], hop: number) {
    setSteps((previous) => [...previous, ...next.map((step) => ({ ...step, hop }))])
  }

  // Every HTTP hop goes through here, so the page can show it.
  const tracedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = request.method === 'POST' ? await request.clone().text() : undefined
    const url = new URL(request.url)
    const index = hopsRef.current.length
    const clientStep = url.pathname.startsWith('/issuer') ? 'client.prover.email' : 'client.request'
    addSteps([{ id: clientStep, detail: `${request.method} ${url.pathname}${url.search}` }], index)
    const response = await fetch(request)
    const responseBody = await response
      .clone()
      .text()
      .catch(() => '')
    const hop: Hop = {
      method: request.method,
      url: request.url,
      path: url.pathname + url.search,
      status: response.status,
      request: [...request.headers],
      response: [...response.headers].filter(([name]) => name !== Trace.header.toLowerCase()),
      body,
      responseBody,
    }
    hopsRef.current = [...hopsRef.current, hop]
    setHops(hopsRef.current)
    addSteps(Trace.decode(response.headers.get(Trace.header)), index)
    return response
  }

  async function crack() {
    if (!config) return
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    setPaused(false)
    try {
      const buy = Client.create({
        account,
        origin: location.origin,
        issuer: `${location.origin}/issuer`,
        email: emailOn && email ? { address: email, code: askForCode } : undefined,
        apiKey: keyOn ? apiKey : undefined,
        fetch: tracedFetch,
      })
      const response = await buy()
      const body = (await response.json()) as Result & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `${response.status}`)
      setResult({ ...body, receipt: Receipt.fromResponse(response).reference })
      await refreshBalance()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function askForCode({ email, id }: { email: string; id: string }) {
    addSteps(
      [{ id: 'client.code', detail: `waiting for the code sent to ${email}` }],
      hopsRef.current.length - 1,
    )
    const message = await fetch(`/api/inbox/${id}`)
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined)
    return new Promise<string | undefined>((resolve) => {
      setCode('')
      setPending({ email, id, message, resolve })
    })
  }

  function submitCode(value: string | undefined) {
    pending?.resolve(value)
    setPending(undefined)
  }

  const tier = keyOn ? 'member' : emailOn && email ? 'email' : 'anonymous'
  const price = config?.prices[tier] ?? '…'
  const idle: NodeId[] = [
    ...(!emailOn && !hops.some((h) => h.path.startsWith('/issuer'))
      ? (['issuer', 'inbox'] as const)
      : []),
    ...(!keyOn ? (['members'] as const) : []),
  ]
  const visited = new Set(
    steps
      .slice(0, cursor + 1)
      .map((step) => stepNode[step.id]?.node)
      .filter(Boolean) as NodeId[],
  )
  const shownFile = files.find((file) => file.name === tab)

  return (
    <div className="page">
      <header>
        <div className="brand">
          <span className="logo">MPP</span>
          <span className="slash">/</span>
          <span>Identity Fortune</span>
        </div>
        <p className="tagline">
          A haiku from a small model, paid per crack on Tempo. Plug in identity on the client and it
          gets cheaper and more personal: <code>mppx</code> identity and payments, running live.
        </p>
      </header>

      <main>
        <section className="panel play">
          <div className="card wallet">
            <div className="row">
              <span className="muted">Wallet</span>
              <a
                href={`${explorer}/address/${account.address}`}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {account.address.slice(0, 6)}…{account.address.slice(-4)}
              </a>
            </div>
            <div className="row">
              <span className="muted">Balance</span>
              <span className="mono">
                {funding ? 'funding from faucet…' : `${balance ?? '…'} pathUSD`}
              </span>
            </div>
          </div>

          <h3>Plug in identity</h3>
          <label className={`prover${emailOn ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={emailOn}
              onChange={(e) => setEmailOn(e.target.checked)}
            />
            <div>
              <div className="prover-title">
                Email <span className="chip">EmailOtp.Client.prover</span>
              </div>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                disabled={!emailOn}
                onChange={(e) => setEmail(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              <div className="hint">
                Verified by a one-time code. @tempo.xyz addresses count as members.
              </div>
            </div>
          </label>
          <label className={`prover${keyOn ? ' on' : ''}`}>
            <input type="checkbox" checked={keyOn} onChange={(e) => setKeyOn(e.target.checked)} />
            <div>
              <div className="prover-title">
                Member key <span className="chip">custom prover</span>
              </div>
              <input
                value={apiKey}
                disabled={!keyOn}
                onChange={(e) => setApiKey(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="mono"
              />
              <div className="hint">Looked up in the server's member table with Identity.from.</div>
            </div>
          </label>

          <div className="tiers">
            {(['anonymous', 'email', 'member'] as const).map((name) => (
              <div key={name} className={`tier${name === tier ? ' current' : ''}`}>
                <div className="tier-name">{name}</div>
                <div className="tier-price">${config?.prices[name] ?? '…'}</div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="crack"
            disabled={busy || funding || !config}
            onClick={crack}
          >
            {busy ? 'Cracking…' : `Crack a fortune · ${price} pathUSD`}
          </button>

          {pending && (
            <div className="card inbox">
              <div className="muted small">Inbox · {pending.email}</div>
              {pending.message ? (
                <>
                  <div className="subject">{pending.message.subject}</div>
                  <div className="otp mono">{pending.message.code}</div>
                  <div className="hint">
                    Demo inbox: email delivery isn't configured, so the issuer shows the code here.
                  </div>
                </>
              ) : (
                <div className="hint">Check your inbox for an 8-digit code.</div>
              )}
              <div className="row gap">
                <input
                  className="mono"
                  placeholder="8-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                />
                <button type="button" onClick={() => submitCode(code || pending.message?.code)}>
                  {code ? 'Verify' : pending.message ? 'Use code' : 'Verify'}
                </button>
                <button type="button" className="ghost" onClick={() => submitCode(undefined)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          {result && (
            <div className="card slip">
              <div className="haiku">
                {result.haiku.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
              <div className="meta">
                <span className="chip">{result.tier}</span>
                <span className="chip">{result.price} pathUSD</span>
                <span className="chip">{result.model}</span>
              </div>
              <div className="seen">
                {result.seen.length > 0 ? (
                  <>Server used: {result.seen.join(', ')}</>
                ) : (
                  <>Server used nothing about you.</>
                )}
              </div>
              {result.receipt && (
                <a
                  className="receipt mono"
                  href={`${explorer}/tx/${result.receipt}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Paid on Tempo · {result.receipt.slice(0, 10)}…
                </a>
              )}
            </div>
          )}
        </section>

        <section className="panel system">
          <div className="panel-head">
            <h3>What's running</h3>
            <div className="controls">
              <button
                type="button"
                className="ghost"
                disabled={steps.length === 0}
                onClick={() => {
                  setCursor(-1)
                  setPaused(false)
                }}
              >
                Replay
              </button>
              <button
                type="button"
                className="ghost"
                disabled={steps.length === 0}
                onClick={() => setPaused((p) => !p)}
              >
                {paused ? 'Play' : 'Pause'}
              </button>
            </div>
          </div>
          <Diagram active={active?.id} label={active?.detail} idle={idle} visited={visited} />
          <div className="steps">
            {steps.length === 0 && (
              <div className="muted small">Crack a fortune to watch each step run.</div>
            )}
            {steps.map((step, i) => (
              <button
                type="button"
                key={i}
                ref={i === cursor ? reveal : undefined}
                className={`step${i === cursor ? ' current' : ''}${i > cursor ? ' future' : ''}`}
                onClick={() => {
                  setCursor(i)
                  setPaused(true)
                }}
              >
                <span className="step-id mono">{step.id}</span>
                <span className="step-detail">{step.detail}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel code">
          <div className="tabs">
            <button
              type="button"
              className={tab === 'usage' ? 'on' : ''}
              onClick={() => setTab('usage')}
            >
              your client
            </button>
            {files.map((file) => (
              <button
                type="button"
                key={file.name}
                className={tab === file.name ? 'on' : ''}
                onClick={() => setTab(file.name)}
              >
                {file.name}
              </button>
            ))}
            {result && (
              <button
                type="button"
                className={tab === 'prompt' ? 'on' : ''}
                onClick={() => setTab('prompt')}
              >
                prompt
              </button>
            )}
            <label className="follow">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />{' '}
              follow
            </label>
          </div>
          <div className="code-body">
            {tab === 'usage' && (
              <MultiFileDiff
                oldFile={{ name: 'your-client.ts', contents: usage.old }}
                newFile={{ name: 'your-client.ts', contents: usage.now }}
                options={{
                  theme: 'pierre-dark',
                  diffStyle: 'unified',
                  disableFileHeader: true,
                  overflow: 'wrap',
                }}
              />
            )}
            {tab === 'prompt' && result && (
              <File
                file={{
                  name: 'prompt.md',
                  contents: `# system\n\n${result.prompt.system}\n\n# user\n\n${result.prompt.user}\n`,
                }}
                options={{ theme: 'pierre-dark', disableFileHeader: true, overflow: 'wrap' }}
              />
            )}
            {shownFile && (
              <CodeFile
                name={shownFile.name}
                contents={shownFile.contents}
                lines={marker && marker.file === shownFile.name ? marker : undefined}
              />
            )}
          </div>
        </section>
      </main>

      <section className="panel timeline">
        <div className="panel-head">
          <h3>HTTP</h3>
          <span className="muted small">Every hop the client made. Copy any as curl.</span>
        </div>
        {hops.length === 0 && <div className="muted small">No requests yet.</div>}
        {hops.map((hop, i) => (
          <HopRow
            key={i}
            hop={hop}
            current={active?.hop === i}
            onSelect={() => {
              const first = steps.findIndex((step) => step.hop === i)
              if (first >= 0) setCursor(first)
              setPaused(true)
            }}
          />
        ))}
      </section>

      <footer className="muted small">
        Built with <a href="https://github.com/wevm/mppx">mppx</a> identity (<code>EmailOtp</code>,{' '}
        <code>Attestation</code>, <code>Identity.from</code>) and Tempo charges on testnet. Source
        in <code>examples/identity-fortune</code>.
      </footer>
    </div>
  )
}

function CodeFile(props: {
  name: string
  contents: string
  lines?: { start: number; end: number } | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!props.lines || !ref.current) return
    const container = ref.current.closest('.code-body')
    const lineHeight = 20
    container?.scrollTo({
      top: Math.max(0, (props.lines.start - 6) * lineHeight),
      behavior: 'smooth',
    })
  }, [props.name, props.lines?.start])
  return (
    <div ref={ref}>
      <File
        file={{ name: props.name, contents: props.contents }}
        selectedLines={props.lines ? { start: props.lines.start, end: props.lines.end } : null}
        options={{ theme: 'pierre-dark', disableFileHeader: true, overflow: 'scroll' }}
      />
    </div>
  )
}

function HopRow(props: { hop: Hop; current: boolean; onSelect: () => void }) {
  const { hop } = props
  const [open, setOpen] = useState(false)
  const interesting = (name: string) =>
    /^(authorization|identity-attestation|identity-attestation-required|x-api-key|www-authenticate|payment-receipt|fortune-upgrades|content-type)$/i.test(
      name,
    )
  const short = (value: string) => (value.length > 96 ? `${value.slice(0, 96)}…` : value)
  const curl = [
    `curl -i '${hop.url}'`,
    hop.method !== 'GET' ? `-X ${hop.method}` : '',
    ...hop.request
      .filter(([name]) => name !== 'content-length')
      .map(([name, value]) => `-H '${name}: ${value}'`),
    hop.body ? `-d '${hop.body}'` : '',
  ]
    .filter(Boolean)
    .join(' \\\n  ')
  return (
    <div className={`hop${props.current ? ' current' : ''}`}>
      <button
        type="button"
        className="hop-line"
        onClick={() => {
          setOpen((o) => !o)
          props.onSelect()
        }}
      >
        <span className="mono method">{hop.method}</span>
        <span className="mono path">{hop.path}</span>
        <span className={`mono status s${String(hop.status)[0]}`}>{hop.status}</span>
      </button>
      {open && (
        <div className="hop-detail mono">
          {hop.request
            .filter(([n]) => interesting(n))
            .map(([n, v]) => (
              <div key={`q${n}`}>
                <span className="arrow">→</span> {n}: {short(v)}
              </div>
            ))}
          {hop.body && (
            <div>
              <span className="arrow">→</span> {short(hop.body)}
            </div>
          )}
          {hop.response
            .filter(([n]) => interesting(n))
            .map(([n, v]) => (
              <div key={`s${n}`}>
                <span className="arrow back">←</span> {n}: {short(v)}
              </div>
            ))}
          <div>
            <span className="arrow back">←</span> {short(hop.responseBody)}
          </div>
          <button
            type="button"
            className="ghost small"
            onClick={() => navigator.clipboard.writeText(curl)}
          >
            Copy as curl
          </button>
        </div>
      )}
    </div>
  )
}

/** The client code for the toggles, shown as a diff as you plug provers in. */
function usageSource(email: boolean, key: boolean, address: string) {
  return [
    "import * as Client from './client'",
    '',
    'const buy = Client.create({',
    '  account,',
    '  origin,',
    '  issuer,',
    ...(email
      ? [`  email: { address: '${address || 'you@example.com'}', code: askForCode },`]
      : []),
    ...(key ? ["  apiKey: 'fortune-demo-key',"] : []),
    '  fetch,',
    '})',
    '',
    'const fortune = await buy()',
    '',
  ].join('\n')
}
