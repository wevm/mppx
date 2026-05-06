import { Mppx, evm } from 'mppx/client'
import { createClient, custom } from 'viem'

const ethereum = (globalThis as { ethereum?: unknown }).ethereum
if (!ethereum) throw new Error('No injected EVM wallet found.')

Mppx.create({
  methods: [
    evm({
      credentialType: 'transaction',
      getClient: () => createClient({ transport: custom(ethereum as never) }),
    }),
  ],
})

document.querySelector('#buy')?.addEventListener('click', async () => {
  const output = document.querySelector('#output')!
  const response = await fetch('/api/data')
  output.textContent = JSON.stringify(await response.json(), null, 2)
})
