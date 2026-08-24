import Fastify from 'fastify'
import { payment } from 'mppx/fastify'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

describe('Fastify middleware', () => {
  test('runs a live paid route and attaches its receipt', async () => {
    const intent = () => async (request: Request) => {
      if (!request.headers.has('Authorization'))
        return {
          challenge: new Response('Payment Required', { status: 402 }),
          status: 402 as const,
        }
      return {
        status: 200 as const,
        withReceipt(response?: Response) {
          if (!response) throw new Mppx.MissingReceiptResponseError()
          const headers = new Headers(response.headers)
          headers.set('Payment-Receipt', 'receipt')
          return new Response(response.body, { headers, status: response.status })
        },
      }
    }
    const app = Fastify()
    app.get('/', { preHandler: payment(intent as any, {}) }, () => ({ paid: true }))
    await app.listen({ port: 0 })

    try {
      const { port } = app.server.address() as { port: number }
      const url = `http://localhost:${port}`
      expect((await globalThis.fetch(url)).status).toBe(402)
      const response = await globalThis.fetch(url, { headers: { Authorization: 'Payment value' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Payment-Receipt')).toBe('receipt')
      expect(await response.json()).toEqual({ paid: true })
    } finally {
      await app.close()
    }
  })
})
