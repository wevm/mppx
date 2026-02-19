import { Mppx, tempo } from 'mppx/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())

const mppx = Mppx.create({
  methods: [tempo({ account })],
})

document.getElementById('button')!.addEventListener('click', async () => {
  const output = document.getElementById('output')!
  const button = document.getElementById('button') as HTMLButtonElement

  button.disabled = true
  output.innerHTML = '<div class="placeholder"></div>'

  try {
    const res = await mppx.fetch('/api/photo')
    if (!res.ok) throw new Error('Request failed')
    const { url } = (await res.json()) as { url: string }
    output.innerHTML = `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="Random photo" /></a>`
    await updateBalance()
  } catch (err) {
    output.innerHTML = `<span class="error">${String(err)}</span>`
  } finally {
    button.disabled = false
  }
})

////////////////////////////////////////////////////////////////////
// Internal

import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const client = createClient({
  chain: tempoModerato,
  pollingInterval: 200,
  transport: http(),
})
const currency = '0x20c0000000000000000000000000000000000000' as const // pathUSD

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

const setup = document.getElementById('setup')!
const ready = document.getElementById('ready')!
const balance = document.getElementById('balance')!

async function updateBalance() {
  const value = await Actions.token.getBalance(client, {
    account,
    token: currency,
  })
  balance.textContent = formatter.format(Number(value) / 1e6)
}

// Fund account on page load, then show balance
try {
  await Actions.faucet.fundSync(client, { account })
  await updateBalance()
  setup.style.display = 'none'
  ready.style.display = 'block'
} catch (err) {
  console.error('Failed to fund account:', err)
  setup.textContent = 'Failed to set up account'
}
