import { tempo } from 'mppx/client'
import { createClient, http, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'

import { chain, networkName, rpcUrl, transportOptions } from './config.js'

import './style.css'

const storageKey = 'mppx.session.playground.privateKey'
const currency = '0x20c0000000000000000000000000000000000001' as const
const decimals = 6
const tokenSymbol = 'pathUSD'
const topUpAmount = '0.0005'

let privateKey = localStorage.getItem(storageKey) as Hex | null
if (!privateKey) {
  privateKey = generatePrivateKey()
  localStorage.setItem(storageKey, privateKey)
}

let account = privateKeyToAccount(privateKey)
let client = createTempoClient()
let session = createSession()
let autoSession = createSession()
let sseSession = createSession()
let bootstrappedChannelId: Hex | null = null
let autoBootstrappedChannelId: Hex | null = null
let clicks = 0
let autoClicks = 0
let sseTokens = 0
let latestSpent = 0n
let autoLatestSpent = 0n
let sseLatestSpent = 0n
let controlsBusy = false

const elements = {
  account: byId('account'),
  autoChannel: byId('auto-channel'),
  autoClick: button('auto-click'),
  autoClicks: byId('auto-clicks'),
  autoClose: button('auto-close'),
  autoCumulative: byId('auto-cumulative'),
  autoDeposit: byId('auto-deposit'),
  autoRun: button('auto-run'),
  autoSpent: byId('auto-spent'),
  balance: byId('balance'),
  bootstrap: button('bootstrap'),
  channel: byId('channel'),
  clearLog: button('clear-log'),
  close: button('close'),
  crank: button('crank'),
  cumulative: byId('cumulative'),
  deposit: byId('deposit'),
  fund: button('fund'),
  log: document.querySelector<HTMLOListElement>('#log')!,
  modeLabel: byId('mode-label'),
  networkEyebrow: byId('network-eyebrow'),
  newWallet: button('new-wallet'),
  refresh: button('refresh'),
  spent: byId('spent'),
  start: button('start'),
  state: byId('state'),
  sseChannel: byId('sse-channel'),
  sseClose: button('sse-close'),
  sseCumulative: byId('sse-cumulative'),
  sseDeposit: byId('sse-deposit'),
  sseOutput: document.querySelector<HTMLPreElement>('#sse-output')!,
  sseSpent: byId('sse-spent'),
  sseStart: button('sse-start'),
  sseTokens: byId('sse-tokens'),
  topUp: button('top-up'),
}

elements.fund.onclick = () => run('fund wallet', fundWallet)
elements.bootstrap.onclick = () => run('bootstrap', bootstrap)
elements.start.onclick = () => run('start session', () => crank({ start: true }))
elements.crank.onclick = () => run('crank session', () => crank())
elements.topUp.onclick = () => run('top up session', topUpSession)
elements.close.onclick = () => run('close session', closeSession)
elements.autoClick.onclick = () => run('auto click', autoClick)
elements.autoRun.onclick = () => run('auto run', autoRun)
elements.autoClose.onclick = () => run('auto close', closeAutoSession)
elements.sseStart.onclick = () => run('SSE stream', runSseStream)
elements.sseClose.onclick = () => run('SSE close', closeSseSession)
elements.refresh.onclick = () => run('refresh', refresh)
elements.clearLog.onclick = () => {
  elements.log.replaceChildren()
}
elements.newWallet.onclick = () =>
  run('new wallet', async () => {
    privateKey = generatePrivateKey()
    localStorage.setItem(storageKey, privateKey)
    account = privateKeyToAccount(privateKey)
    client = createTempoClient()
    session = createSession()
    autoSession = createSession()
    sseSession = createSession()
    bootstrappedChannelId = null
    autoBootstrappedChannelId = null
    clicks = 0
    autoClicks = 0
    sseTokens = 0
    latestSpent = 0n
    autoLatestSpent = 0n
    sseLatestSpent = 0n
    elements.sseOutput.textContent = ''
    log(`created ${short(account.address)}`)
    await refresh()
  })

await checkHealth()
await refresh()
await bootstrap().catch((error) => {
  log(`bootstrap failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
})

function createTempoClient() {
  return createClient({
    account,
    chain,
    pollingInterval: 1_000,
    transport: http(rpcUrl, transportOptions),
  })
}

function createSession() {
  return tempo.session({
    account,
    client,
    decimals,
    maxDeposit: '0.002',
  })
}

async function fundWallet() {
  const response = await fetch('/api/fund', {
    body: JSON.stringify({ address: account.address }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(await readError(response))
  log(`funded ${short(account.address)}`)
  await refresh()
}

async function checkHealth() {
  const response = await fetch('/api/health')
  if (!response.ok) return
  const health = (await response.json()) as { precompileAvailable?: boolean; network?: string }
  if (health.precompileAvailable === false) {
    log('Explorer has TIP-1034 metadata, but this RPC returns no data for TIP-1034 calls', 'error')
  }
  if (health.network) log(`connected to ${health.network}`)
}

async function bootstrap() {
  const response = await fetch(`/api/bootstrap?payer=${account.address}`)
  if (!response.ok) throw new Error(await readError(response))
  const data = (await response.json()) as {
    acceptedCumulative?: string
    channelId: Hex | null
    deposit?: string
    spent?: string
    units?: number
  }
  bootstrappedChannelId = data.channelId
  if (data.spent) latestSpent = BigInt(data.spent)
  if (typeof data.units === 'number') clicks = data.units

  if (data.channelId) {
    log(`server bootstrap found ${short(data.channelId)}`)
    if (session.channelId?.toLowerCase() !== data.channelId.toLowerCase())
      await hydrateFromServerSnapshot()
  } else {
    log('server bootstrap found no open channel')
  }
  await refresh()
}

async function hydrateFromServerSnapshot() {
  if (!bootstrappedChannelId) return
  const response = await session.fetch(clickUrl(clicks, bootstrappedChannelId, session), {
    method: 'HEAD',
  })
  if (!response.ok) throw new Error(`bootstrap HEAD failed: ${await readError(response)}`)
  if (response.receipt) latestSpent = BigInt(response.receipt.spent)
  if (typeof response.receipt?.units === 'number') clicks = response.receipt.units
  log(`hydrated manager from server snapshot (${short(bootstrappedChannelId)})`)
}

async function crank(options: { start?: boolean } = {}) {
  const nextClicks = clicks + 1
  const response = await session.fetch(clickUrl(nextClicks, bootstrappedChannelId, session))
  if (!response.ok) throw new Error(await readError(response))
  const body = (await response.json()) as { click: number; message: string; price: string }
  if (response.channelId) bootstrappedChannelId = response.channelId
  if (response.receipt) {
    latestSpent = BigInt(response.receipt.spent)
    clicks = response.receipt.units ?? nextClicks
  } else {
    clicks = nextClicks
  }
  log(`${options.start ? 'started' : 'cranked'}: ${body.message}`)
  await refresh()
}

async function autoClick() {
  const nextClicks = autoClicks + 1
  const response = await autoSession.fetch(
    clickUrl(nextClicks, autoBootstrappedChannelId, autoSession),
  )
  if (!response.ok) throw new Error(await readError(response))
  const body = (await response.json()) as { click: number; message: string; price: string }
  if (response.channelId) autoBootstrappedChannelId = response.channelId
  if (response.receipt) {
    autoLatestSpent = BigInt(response.receipt.spent)
    autoClicks = response.receipt.units ?? nextClicks
  } else {
    autoClicks = nextClicks
  }
  log(`auto: ${body.message}`)
  await refresh()
}

async function autoRun() {
  const target = autoClicks + 12
  while (autoClicks < target) await autoClick()
}

async function runSseStream() {
  elements.sseOutput.textContent = ''
  sseTokens = 0
  sseLatestSpent = 0n

  const stream = await sseSession.sse(streamUrl(), {
    onReceipt(receipt) {
      sseLatestSpent = BigInt(receipt.spent)
      if (typeof receipt.units === 'number') sseTokens = receipt.units
    },
  })

  for await (const token of stream) {
    elements.sseOutput.textContent += token
    sseTokens += 1
    await refresh()
  }

  log(`SSE streamed ${sseTokens} chunks`)
  await refresh()
}

async function closeSession() {
  const receipt = await session.close()
  if (!receipt) {
    log('nothing to close')
    return
  }
  latestSpent = BigInt(receipt.spent)
  bootstrappedChannelId = null
  log(`closed ${short(receipt.channelId)} at ${formatAmount(BigInt(receipt.spent))}`)
  await refresh()
}

async function closeAutoSession() {
  const receipt = await autoSession.close()
  if (!receipt) {
    log('nothing to close for auto flow')
    return
  }
  autoLatestSpent = BigInt(receipt.spent)
  autoBootstrappedChannelId = null
  log(`closed auto ${short(receipt.channelId)} at ${formatAmount(BigInt(receipt.spent))}`)
  await refresh()
}

async function closeSseSession() {
  const receipt = await sseSession.close()
  if (!receipt) {
    log('nothing to close for SSE flow')
    return
  }
  sseLatestSpent = BigInt(receipt.spent)
  log(`closed SSE ${short(receipt.channelId)} at ${formatAmount(BigInt(receipt.spent))}`)
  await refresh()
}

async function topUpSession() {
  const receipt = await session.topUp(topUpAmount)
  if (receipt) latestSpent = BigInt(receipt.spent)
  log(
    `topped up ${topUpAmount} ${tokenSymbol}${receipt?.txHash ? ` (${short(receipt.txHash)})` : ''}`,
  )
  await refresh()
}

async function refresh() {
  elements.account.textContent = account.address
  elements.networkEyebrow.textContent = networkName
  elements.modeLabel.textContent = `${networkName} / TIP-1034 precompile`
  elements.balance.textContent = await getBalance().catch((error) =>
    error instanceof Error ? error.message : 'unavailable',
  )
  elements.channel.textContent = short(session.channelId ?? bootstrappedChannelId)
  elements.spent.textContent = formatAmount(latestSpent)
  elements.deposit.textContent = formatAmount(depositOf(session))
  elements.cumulative.textContent = formatAmount(session.cumulative)
  elements.autoChannel.textContent = short(autoSession.channelId ?? autoBootstrappedChannelId)
  elements.autoClicks.textContent = String(autoClicks)
  elements.autoSpent.textContent = formatAmount(autoLatestSpent)
  elements.autoDeposit.textContent = formatAmount(depositOf(autoSession))
  elements.autoCumulative.textContent = formatAmount(autoSession.cumulative)
  elements.sseChannel.textContent = short(sseSession.channelId)
  elements.sseTokens.textContent = String(sseTokens)
  elements.sseSpent.textContent = formatAmount(sseLatestSpent)
  elements.sseDeposit.textContent = formatAmount(depositOf(sseSession))
  elements.sseCumulative.textContent = formatAmount(sseSession.cumulative)
  elements.state.textContent = JSON.stringify(
    {
      manual: {
        manager: session.state,
        opened: session.opened,
        channelId: session.channelId ?? bootstrappedChannelId,
        clicks,
      },
      auto: {
        manager: autoSession.state,
        opened: autoSession.opened,
        channelId: autoSession.channelId ?? autoBootstrappedChannelId,
        clicks: autoClicks,
      },
      sse: {
        manager: sseSession.state,
        opened: sseSession.opened,
        channelId: sseSession.channelId,
        tokens: sseTokens,
      },
    },
    null,
    2,
  )
  applyControlState()
}

function clickUrl(
  nextClicks = clicks,
  channelId: Hex | null = bootstrappedChannelId,
  manager = session,
) {
  const url = new URL('/api/click', window.location.origin)
  url.searchParams.set('count', String(nextClicks))
  if (channelId && !manager.channelId) {
    url.searchParams.set('channelId', channelId)
  }
  return url
}

function streamUrl() {
  const url = new URL('/api/stream', window.location.origin)
  url.searchParams.set('prompt', 'automatic SSE top-up')
  return url
}

async function getBalance() {
  const value = await Actions.token.getBalance(client, { account, token: currency })
  return formatAmount(value)
}

async function run(label: string, action: () => Promise<void>) {
  setDisabled(true)
  try {
    await action()
  } catch (error) {
    log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    setDisabled(false)
  }
}

function setDisabled(disabled: boolean) {
  controlsBusy = disabled
  applyControlState()
}

function applyControlState() {
  const allButtons = [
    elements.bootstrap,
    elements.autoClick,
    elements.autoClose,
    elements.autoRun,
    elements.close,
    elements.crank,
    elements.fund,
    elements.newWallet,
    elements.refresh,
    elements.sseClose,
    elements.sseStart,
    elements.start,
    elements.topUp,
  ]
  for (const element of allButtons) element.disabled = controlsBusy
  if (controlsBusy) return

  const manualOpen = session.opened || Boolean(bootstrappedChannelId && !session.channelId)
  elements.start.disabled = session.opened
  elements.crank.disabled = !manualOpen
  elements.topUp.disabled = !session.opened
  elements.close.disabled = !session.opened

  elements.autoClose.disabled = !autoSession.opened

  elements.sseStart.disabled = sseSession.opened
  elements.sseClose.disabled = !sseSession.opened
}

function depositOf(manager: ReturnType<typeof createSession>) {
  const state = manager.state
  if ('deposit' in state) return BigInt(state.deposit)
  return 0n
}

async function readError(response: Response) {
  const body = await response.text()
  if (!body) return `${response.status} ${response.statusText}`
  try {
    const data = JSON.parse(body) as { detail?: string; error?: string; title?: string }
    return data.detail ?? data.error ?? data.title ?? body
  } catch {
    return body
  }
}

function log(message: string, type: 'info' | 'error' = 'info') {
  const item = document.createElement('li')
  item.className = type
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`
  elements.log.prepend(item)
}

function formatAmount(value: bigint) {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''} ${tokenSymbol}`
}

function short(value: string | null | undefined) {
  if (!value) return 'none'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function byId(id: string) {
  return document.getElementById(id)!
}

function button(id: string) {
  return document.getElementById(id) as HTMLButtonElement
}
