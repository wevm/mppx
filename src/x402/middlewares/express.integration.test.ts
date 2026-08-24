import { x402ResourceServer } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import express from 'express'
import { Receipt } from 'mppx'
import { evm, Fetch } from 'mppx/client'
import { mpp } from 'mppx/x402/express'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

import * as ChallengeBrand from '../internal/ChallengeBrand.js'
import * as Types from '../Types.js'

const network = 'eip155:84532' as const
const recipient = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const secretKey = 'test-secret-key-test-secret-key-32'
const transaction = `0x${'1'.repeat(64)}`
const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)

/** Starts a real Express HTTP server using the same x402 route table for both protocols. */
async function createServer(
  options: {
    skipHandler?: boolean
    skipHandlerResponse?: { body: unknown; contentType: string }
  } = {},
) {
  const calls: string[] = []
  let handlerCalls = 0
  const facilitator = {
    async getSupported() {
      return {
        extensions: [],
        kinds: [
          { extra: { assetTransferMethod: 'eip3009' }, network, scheme: 'exact', x402Version: 2 },
        ],
        signers: {},
      }
    },
    async settle() {
      calls.push('settle')
      return { network, payer: account.address, success: true, transaction }
    },
    async verify() {
      calls.push('verify')
      return { isValid: true, payer: account.address }
    },
  }
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
  if (options.skipHandler)
    resourceServer.onAfterVerify(async () => ({
      response: options.skipHandlerResponse ?? { body: { acknowledged: true } },
      skipHandler: true,
    }))
  const routes = {
    'GET /api/data': {
      accepts: { network, payTo: recipient, price: '$0.01', scheme: 'exact' },
      description: 'Premium data access',
      mimeType: 'application/json',
    },
  } as const

  const app = express()
  app.use(mpp(routes, resourceServer, { secretKey }))
  app.get('/api/data', (_request, response) => {
    handlerCalls++
    response.json({ data: 'premium content' })
  })

  const server = await new Promise<Http.TestServer>((resolve) => {
    const listener = app.listen(0, () => {
      const { port } = listener.address() as { port: number }
      resolve(Http.wrapServer(listener, { port, url: `http://localhost:${port}` }))
    })
  })
  return { calls, getHandlerCalls: () => handlerCalls, server }
}

const method = evm.charge({
  account,
  authorization: { name: 'USDC', version: '2' },
  maxAtomicAmount: '1000000',
})

describe('x402 Express compatibility', () => {
  test('rejects combined MPP and legacy x402 credentials', async () => {
    const { server } = await createServer()
    try {
      const response = await globalThis.fetch(`${server.url}/api/data`, {
        headers: {
          Authorization: 'Bearer token, Payment invalid',
          [Types.legacyPaymentSignatureHeader]: 'invalid',
        },
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'Send either an MPP credential or an x402 payment signature, not both.',
      })
    } finally {
      server.close()
    }
  })

  test('serves one live route to MPP and x402 clients', async () => {
    const { calls, server } = await createServer()
    try {
      const unpaid = await globalThis.fetch(`${server.url}/api/data`)
      expect(unpaid.status).toBe(402)
      expect(unpaid.headers.get('WWW-Authenticate')).toContain('Payment')
      expect(unpaid.headers.get(Types.paymentRequiredHeader)).toBeTruthy()

      const mppFetch = Fetch.from({
        methods: [method],
        orderChallenges: (candidates) =>
          [...candidates].sort(
            (a, b) =>
              Number(ChallengeBrand.is(a.challenge)) - Number(ChallengeBrand.is(b.challenge)),
          ),
      })
      const mppResponse = await mppFetch(`${server.url}/api/data`)
      expect(mppResponse.status).toBe(200)
      expect(await mppResponse.json()).toEqual({ data: 'premium content' })
      expect(Receipt.fromResponse(mppResponse).reference).toBe(transaction)

      const x402Fetch = Fetch.from({
        methods: [method],
        orderChallenges: (candidates) =>
          [...candidates].sort(
            (a, b) =>
              Number(ChallengeBrand.is(b.challenge)) - Number(ChallengeBrand.is(a.challenge)),
          ),
      })
      const x402Response = await x402Fetch(`${server.url}/api/data`)
      expect(x402Response.status).toBe(200)
      expect(await x402Response.json()).toEqual({ data: 'premium content' })
      expect(x402Response.headers.get(Types.paymentResponseHeader)).toBeTruthy()

      expect(calls).toEqual(['verify', 'settle', 'verify', 'settle'])
    } finally {
      server.close()
    }
  })

  test('honors x402 skipHandler hooks for MPP credentials', async () => {
    const { calls, getHandlerCalls, server } = await createServer({ skipHandler: true })
    try {
      const mppFetch = Fetch.from({
        methods: [method],
        orderChallenges: (candidates) =>
          [...candidates].sort(
            (a, b) =>
              Number(ChallengeBrand.is(a.challenge)) - Number(ChallengeBrand.is(b.challenge)),
          ),
      })

      const response = await mppFetch(`${server.url}/api/data`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ acknowledged: true })
      expect(response.headers.get('Payment-Receipt')).toBeTruthy()
      expect(getHandlerCalls()).toBe(0)
      expect(calls).toEqual(['verify', 'settle'])
    } finally {
      server.close()
    }
  })

  test('preserves non-JSON x402 skipHandler bodies for MPP credentials', async () => {
    const { server } = await createServer({
      skipHandler: true,
      skipHandlerResponse: { body: 'accepted', contentType: 'text/plain' },
    })
    try {
      const mppFetch = Fetch.from({ methods: [method] })

      const response = await mppFetch(`${server.url}/api/data`)

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('text/plain')
      expect(await response.text()).toBe('accepted')
    } finally {
      server.close()
    }
  })
})
