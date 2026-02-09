import { Fetch, tempo } from 'mpay/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const account = privateKeyToAccount(generatePrivateKey())

const client = createClient({ chain: tempoModerato, transport: http() })
await Actions.faucet.fundSync(client, { account })

const paidFetch = Fetch.from({
  methods: [tempo.charge({ account })],
})

const res = await paidFetch('http://localhost:3000/api/fortune')
console.log(await res.json())
