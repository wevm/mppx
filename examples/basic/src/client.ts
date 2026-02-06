import { Fetch, tempo } from 'mpay/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(generatePrivateKey())

Fetch.polyfill({
  methods: [tempo.charge({ account })],
})

document.getElementById('button')!.addEventListener('click', async () => {
  const output = document.getElementById('output')!

  output.textContent = loadingMessages[Math.floor(Math.random() * loadingMessages.length)]!

  try {
    const { fortune } = await fetch('/api/fortune').then((r) => r.json())
    output.textContent = fortune
    await updateBalance()
  } catch (err) {
    output.textContent = String(err)
  }
})

const loadingMessages = [
  'Consulting the oracle...',
  'Gazing into the crystal ball...',
  'Reading your palm...',
  'The spirits are speaking...',
  'Shaking the magic 8-ball...',
  'Paying the seer...',
]

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
const currency = '0x20c0000000000000000000000000000000000001' as const

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
