import { Mppx as ClientMppx, tempo as tempoClient, x402 as x402Client } from 'mppx/client'
import {
  Mppx as ServerMppx,
  NodeListener,
  Request as ServerRequest,
  tempo,
  x402 as x402Server,
} from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as Header from './Header.js'
import * as Types from './Types.js'

const secretKey = 'test-secret'
const transaction = `0x${'1'.repeat(64)}`

describe('x402 exact e2e', () => {
  test('serves tempo and x402 paid routes from a live server', async () => {
    const tempoPayment = ServerMppx.create({
      methods: [
        tempo.charge({
          account: accounts[0],
          currency: asset,
          getClient: () => client,
          recipient: accounts[0].address,
        }),
      ],
      secretKey,
    })

    const facilitator: Types.Facilitator = {
      async verify(paymentPayload) {
        return {
          isValid: true,
          payer: payerOf(paymentPayload),
        }
      },
      async settle(paymentPayload) {
        return {
          network: paymentPayload.accepted.network,
          payer: payerOf(paymentPayload),
          success: true,
          transaction,
        }
      },
    }
    const x402Payment = ServerMppx.create({
      methods: [
        x402Server.exact({
          config: {
            currency: x402Server.assets.baseSepolia.USDC,
            facilitator,
            recipient: accounts[0].address,
          },
        }),
      ],
      secretKey,
    })

    const server = await Http.createServer(async (req, res) => {
      const request = ServerRequest.fromNodeListener(req, res)

      if (req.url === '/tempo') {
        const result = await tempoPayment.tempo.charge({
          amount: '0',
          chainId: client.chain!.id,
        })(request)
        if (result.status === 402) return NodeListener.sendResponse(res, result.challenge)
        return NodeListener.sendResponse(res, result.withReceipt(new Response('tempo ok')))
      }

      if (req.url === '/x402') {
        const result = await x402Payment.x402.exact({
          amount: '10000',
          resource: {
            mimeType: 'text/plain',
            url: new URL('/x402', request.url).toString(),
          },
        })(request)
        if (result.status === 402) return NodeListener.sendResponse(res, result.challenge)
        return NodeListener.sendResponse(res, result.withReceipt(new Response('x402 ok')))
      }

      return NodeListener.sendResponse(res, new Response('not found', { status: 404 }))
    })

    try {
      const tempoClientPayment = ClientMppx.create({
        methods: [
          tempoClient.charge({
            account: accounts[0],
            getClient: () => client,
          }),
        ],
        polyfill: false,
      })
      const tempoResponse = await tempoClientPayment.fetch(`${server.url}/tempo`)
      expect(tempoResponse.status).toBe(200)
      expect(await tempoResponse.text()).toBe('tempo ok')
      expect(tempoResponse.headers.has('Payment-Receipt')).toBe(true)

      const x402ClientPayment = ClientMppx.create({
        methods: [
          x402Client.exact({
            account: accounts[0],
          }),
        ],
        polyfill: false,
      })
      const x402Required = await x402ClientPayment.rawFetch(`${server.url}/x402`)
      expect(x402Required.status).toBe(402)
      expect(x402Required.headers.has(Types.paymentRequiredHeader)).toBe(true)

      const paymentSignature = await x402ClientPayment.createCredential(x402Required)
      const paymentPayload = Header.decodePaymentSignature(paymentSignature)
      expect(paymentPayload.accepted.scheme).toBe('exact')

      const x402Response = await x402ClientPayment.fetch(`${server.url}/x402`)
      expect(x402Response.status).toBe(200)
      expect(await x402Response.text()).toBe('x402 ok')

      const paymentResponseHeader = x402Response.headers.get(Types.paymentResponseHeader)
      expect(paymentResponseHeader).toBeTruthy()
      expect(Header.decodePaymentResponse(paymentResponseHeader!).transaction).toBe(transaction)
    } finally {
      server.close()
    }
  })

  test('serves tempo and x402 from one composed live endpoint', async () => {
    const payment = ServerMppx.create({
      methods: [
        tempo.charge({
          account: accounts[0],
          currency: asset,
          getClient: () => client,
          recipient: accounts[0].address,
        }),
        x402Server.exact({
          config: {
            currency: x402Server.assets.baseSepolia.USDC,
            facilitator: {
              async verify(paymentPayload) {
                return {
                  isValid: true,
                  payer: payerOf(paymentPayload),
                }
              },
              async settle(paymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  payer: payerOf(paymentPayload),
                  success: true,
                  transaction,
                }
              },
            },
            recipient: accounts[0].address,
          },
        }),
      ],
      secretKey,
    })
    const paid = payment.compose(
      [payment.tempo.charge, { amount: '0', chainId: client.chain!.id }],
      [payment.x402.exact, { amount: '10000' }],
    )

    const server = await Http.createServer(async (req, res) => {
      const request = ServerRequest.fromNodeListener(req, res)
      const result = await paid(request)
      if (result.status === 402) return NodeListener.sendResponse(res, result.challenge)
      return NodeListener.sendResponse(res, result.withReceipt(new Response('paid ok')))
    })

    try {
      const challenge = await fetch(server.url)
      expect(challenge.status).toBe(402)
      expect(challenge.headers.has('WWW-Authenticate')).toBe(true)
      expect(challenge.headers.has(Types.paymentRequiredHeader)).toBe(true)

      const tempoClientPayment = ClientMppx.create({
        methods: [
          tempoClient.charge({
            account: accounts[0],
            getClient: () => client,
          }),
        ],
        polyfill: false,
      })
      const tempoResponse = await tempoClientPayment.fetch(server.url)
      expect(tempoResponse.status).toBe(200)
      expect(await tempoResponse.text()).toBe('paid ok')
      expect(tempoResponse.headers.has('Payment-Receipt')).toBe(true)

      const x402ClientPayment = ClientMppx.create({
        methods: [
          x402Client.exact({
            account: accounts[0],
          }),
        ],
        polyfill: false,
      })
      const x402Response = await x402ClientPayment.fetch(server.url)
      expect(x402Response.status).toBe(200)
      expect(await x402Response.text()).toBe('paid ok')
      expect(x402Response.headers.has(Types.paymentResponseHeader)).toBe(true)
    } finally {
      server.close()
    }
  })
})

function payerOf(paymentPayload: Types.PaymentPayload): string {
  if ('authorization' in paymentPayload.payload) return paymentPayload.payload.authorization.from
  return paymentPayload.payload.permit2Authorization.from
}
