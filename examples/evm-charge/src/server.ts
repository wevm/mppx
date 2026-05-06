import { Mppx, evm } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.MPPX_PRIVATE_KEY as `0x${string}`)
const chainId = Number(process.env.MPPX_CHAIN_ID ?? 1)
const currency = process.env.MPPX_TOKEN_ADDRESS as `0x${string}`
const rpcUrl = process.env.MPPX_RPC_URL

const mppx = Mppx.create({
  methods: [
    evm({
      account,
      amount: '1',
      chainId,
      credentialTypes: ['transaction', 'hash'],
      currency,
      decimals: Number(process.env.MPPX_TOKEN_DECIMALS ?? 6),
      recipient: account.address,
      rpcUrl: rpcUrl ? { [chainId]: rpcUrl } : undefined,
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/data') return null

  const result = await mppx.charge({
    amount: '1',
    description: 'EVM ERC-20 charge example',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ ok: true, paid: true }))
}
