import { evm, Fetch } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000'
const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined

if (!privateKey) throw new Error('Set PRIVATE_KEY to a Base Sepolia account funded with USDC.')

const payments = Fetch.from({
  methods: [
    evm.charge({
      account: privateKeyToAccount(privateKey),
      currencies: [evm.assets.baseSepolia.USDC],
      maxAmount: '0.01',
      networks: [84532],
    }),
  ],
})

const response = await payments(`${baseUrl}/api/data`)
const receipt = response.headers.get('Payment-Receipt') ?? response.headers.get('PAYMENT-RESPONSE')

if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)

console.log(await response.text())
console.log(`receipt: ${receipt ? 'yes' : 'no'}`)
