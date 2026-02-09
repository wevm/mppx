import { PaidRoute } from '@mpp/nextjs'
import { Mpay, tempo } from 'mpay/server'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      feePayer: account,
      recipient: account.address,
      testnet: true,
    }),
  ],
})

export const GET = PaidRoute(mpay.charge({ amount: '1' }), async (_request, { withReceipt }) => {
  return withReceipt(
    Response.json({ fortune: 'A golden egg of opportunity falls into your lap this month.' }),
  )
})
