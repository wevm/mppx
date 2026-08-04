import { Credential, Method, Receipt, z } from 'mppx'

const method = Method.from({
  name: 'demo',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.literal('paid') }) },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
    }),
  },
})

export const clientMethod = Method.toClient(method, {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'paid' } })
  },
})

export const serverMethod = Method.toServer(method, {
  async broadcast() {
    return Receipt.from({
      method: 'demo',
      reference: crypto.randomUUID(),
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
