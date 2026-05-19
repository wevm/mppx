import { Mppx, tempo } from 'mppx/client'
import { createClient, formatUnits, http, parseUnits, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoDevnet, tempoLocalnet, tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

type Config = {
  chainId: number
  currency: Address
  decimals: number
  network: 'devnet' | 'localnet' | 'testnet'
  pricePerUnit: string
  recipient: Address
  rpcUrl: string
  serverBalance: string
}

type Authorization = {
  amount: string
  capturedAmount: string
  id: Hex
  openTxHash: Hex
  remainingAmount: string
  status: 'authorized' | 'closed' | 'voided'
}

const statusEl = element('status')
const unitsInput = element<HTMLInputElement>('units')
const unitPriceEl = element('unit-price')
const totalEl = element('authorize-total')
const authorizeButton = element<HTMLButtonElement>('authorize')
const tbody = element<HTMLTableSectionElement>('authorizations')
const privateKeyStorageKey = 'mppx.authorize.privateKey'

let config!: Config
let mppx!: ReturnType<typeof Mppx.create>
let busy = false

void boot().catch((error) => {
  setStatus(errorMessage(error))
})

async function boot() {
  setStatus('Loading config...')
  config = await requestJson<Config>('/api/config')
  const account = privateKeyToAccount(loadPrivateKey())
  const client = createClient({
    account,
    chain:
      config.network === 'devnet'
        ? tempoDevnet
        : config.network === 'localnet'
          ? tempoLocalnet
          : tempoModerato,
    pollingInterval: 1_000,
    transport: http(config.rpcUrl),
  })
  mppx = Mppx.create({
    methods: [
      tempo.authorize({
        account,
        getClient: () => client,
      }),
    ],
  })

  setStatus(`Funding ${short(account.address)} on ${config.network}...`)
  await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
  const balance = await Actions.token.getBalance(client, { account, token: config.currency })
  setStatus(
    `Payer ${short(account.address)} | balance ${formatUnits(balance, config.decimals)} pathUSD`,
  )

  unitPriceEl.textContent = money(config.pricePerUnit)
  unitsInput.addEventListener('input', updateTotal)
  authorizeButton.addEventListener('click', () => void createAuthorization())
  tbody.addEventListener('click', (event) => void handleTableClick(event))
  updateTotal()
  await refreshAuthorizations()
}

async function createAuthorization() {
  if (busy) return
  busy = true
  authorizeButton.disabled = true
  try {
    const amount = authorizeAmount()
    setStatus(`Authorizing ${money(amount)}...`)
    await requestJson('/api/authorizations?amount=' + encodeURIComponent(amount), {
      fetcher: mppx.fetch,
      init: { method: 'POST' },
    })
    await refreshAuthorizations()
    setStatus(`Authorized ${money(amount)}`)
  } catch (error) {
    setStatus(errorMessage(error))
  } finally {
    busy = false
    authorizeButton.disabled = false
  }
}

async function handleTableClick(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLButtonElement)) return
  const id = target.dataset.id as Hex | undefined
  const action = target.dataset.action
  if (!id || !action) return

  const row = target.closest('tr')
  const input = row?.querySelector<HTMLInputElement>('input[data-capture]')
  const amount = input?.value

  target.disabled = true
  try {
    if (action === 'void') {
      setStatus(`Voiding ${short(id)}...`)
      await requestJson(`/api/authorizations/${id}/void`, { init: { method: 'POST' } })
      setStatus(`Voided ${short(id)}`)
    } else {
      if (!amount) throw new Error('Missing capture amount.')
      setStatus(`${action === 'close' ? 'Capturing and closing' : 'Capturing'} ${money(amount)}...`)
      await requestJson(`/api/authorizations/${id}/capture`, {
        init: {
          body: JSON.stringify({ amount, close: action === 'close' }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      })
      setStatus(`${action === 'close' ? 'Closed' : 'Captured'} ${short(id)}`)
    }
    await refreshAuthorizations()
  } catch (error) {
    setStatus(errorMessage(error))
  } finally {
    target.disabled = false
  }
}

async function refreshAuthorizations() {
  const body = await requestJson<{ authorizations: Authorization[] }>('/api/authorizations')
  renderAuthorizations(body.authorizations)
}

function renderAuthorizations(authorizations: Authorization[]) {
  tbody.replaceChildren()
  if (authorizations.length === 0) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.className = 'empty'
    td.colSpan = 7
    td.textContent = 'No authorizations yet.'
    tr.append(td)
    tbody.append(tr)
    return
  }

  for (const authorization of authorizations) tbody.append(renderAuthorization(authorization))
}

function renderAuthorization(authorization: Authorization) {
  const tr = document.createElement('tr')
  const disabled = authorization.status !== 'authorized'
  const suggestedCapture = minDecimal(config.pricePerUnit, authorization.remainingAmount)
  tr.innerHTML = `
    <td class="mono">${short(authorization.id)}</td>
    <td><span class="pill ${authorization.status}">${authorization.status}</span></td>
    <td>${money(authorization.amount)}</td>
    <td>${money(authorization.capturedAmount)}</td>
    <td>${money(authorization.remainingAmount)}</td>
    <td class="mono">${short(authorization.openTxHash)}</td>
    <td>
      <div class="row-actions">
        <input data-capture type="number" min="0" step="0.01" value="${suggestedCapture}" ${disabled ? 'disabled' : ''} />
        <button data-action="capture" data-id="${authorization.id}" class="secondary" type="button" ${disabled ? 'disabled' : ''}>Capture</button>
        <button data-action="close" data-id="${authorization.id}" class="secondary" type="button" ${disabled ? 'disabled' : ''}>Capture & close</button>
        <button data-action="void" data-id="${authorization.id}" class="danger" type="button" ${disabled ? 'disabled' : ''}>Void</button>
      </div>
    </td>
  `
  return tr
}

function updateTotal() {
  totalEl.textContent = money(authorizeAmount())
}

function authorizeAmount() {
  const units = Math.max(1, Math.floor(Number(unitsInput.value || '1')))
  return formatUnits(
    parseUnits(config.pricePerUnit, config.decimals) * BigInt(units),
    config.decimals,
  )
}

async function requestJson<value>(
  url: string,
  options: { fetcher?: typeof fetch; init?: RequestInit } = {},
): Promise<value> {
  const response = await (options.fetcher ?? fetch)(url, options.init)
  const body = (await response.json().catch(() => null)) as value | { error?: string } | null
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && body.error
        ? body.error
        : `Request failed: ${response.status}`
    throw new Error(message)
  }
  return body as value
}

function loadPrivateKey() {
  const existing = localStorage.getItem(privateKeyStorageKey)
  if (existing) return existing as Hex
  const privateKey = generatePrivateKey()
  localStorage.setItem(privateKeyStorageKey, privateKey)
  return privateKey
}

function minDecimal(a: string, b: string) {
  const aRaw = parseUnits(a, config.decimals)
  const bRaw = parseUnits(b, config.decimals)
  return formatUnits(aRaw < bRaw ? aRaw : bRaw, config.decimals)
}

function money(value: string) {
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 6,
    style: 'currency',
  }).format(Number(value))
}

function short(value: string) {
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function setStatus(message: string) {
  statusEl.textContent = message
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function element<type extends HTMLElement = HTMLElement>(id: string) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as type
}
