import { evm as evmClient, Mppx as ClientMppx, tempo as tempoClient } from 'mppx/client'
import { evm, Mppx as ServerMppx, NodeListener, Request as ServerRequest, tempo } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as Header from './Header.js'
import * as RouteBinding from './internal/RouteBinding.js'
import * as Types from './Types.js'

const secretKey = 'test-secret-key-test-secret-key-32'
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
        evm.charge({
          currency: evm.assets.baseSepolia.USDC,
          recipient: accounts[0].address,
          x402: { facilitator },
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
        const result = await x402Payment.evm.charge({
          amount: '0.01',
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
          evmClient.charge({
            account: accounts[0],
          }),
        ],
        polyfill: false,
      })
      const x402Required = await x402ClientPayment.rawFetch(`${server.url}/x402`)
      expect(x402Required.status).toBe(402)
      expect(x402Required.headers.has(Types.paymentRequiredHeader)).toBe(true)

      const paymentSignature = await x402ClientPayment.createCredential(
        pureX402Challenge(x402Required),
      )
      const paymentPayload = Header.decodePaymentSignature(paymentSignature)
      expect(paymentPayload.accepted.scheme).toBe('exact')

      const x402Response = await x402ClientPayment.rawFetch(`${server.url}/x402`, {
        headers: { [Types.paymentSignatureHeader]: paymentSignature },
      })
      expect(x402Response.status).toBe(200)
      expect(await x402Response.text()).toBe('x402 ok')

      const paymentResponseHeader = x402Response.headers.get(Types.paymentResponseHeader)
      expect(paymentResponseHeader).toBeTruthy()
      expect(Header.decodePaymentResponse(paymentResponseHeader!).transaction).toBe(transaction)
    } finally {
      server.close()
    }
  })

  test('rejects x402 payment payload replayed across resources with same requirements', async () => {
    let verifyCalls = 0
    const payment = ServerMppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.baseSepolia.USDC,
          recipient: accounts[0].address,
          x402: {
            facilitator: {
              async verify() {
                verifyCalls++
                return { isValid: true }
              },
              async settle(paymentPayload: Types.PaymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey,
    })
    const route = payment.evm.charge({ amount: '0.01' })

    const routeAChallenge = await route(new Request('https://example.com/a'))
    expect(routeAChallenge.status).toBe(402)
    if (routeAChallenge.status !== 402) throw new Error()

    const paymentRequired = Header.decodePaymentRequired(
      routeAChallenge.challenge.headers.get(Types.paymentRequiredHeader)!,
    )
    const accepted = paymentRequired.accepts[0]!
    const paymentSignature = Header.encodePaymentSignature({
      accepted,
      payload: {
        authorization: {
          from: accounts[0].address,
          nonce: `0x${'1'.repeat(64)}`,
          to: accepted.payTo as `0x${string}`,
          validAfter: '0',
          validBefore: '9999999999',
          value: accepted.amount,
        },
        signature: `0x${'2'.repeat(130)}`,
      },
      resource: paymentRequired.resource,
      x402Version: 2,
    })

    const result = await route(
      new Request('https://example.com/b', {
        headers: { [Types.paymentSignatureHeader]: paymentSignature },
      }),
    )

    expect(result.status).toBe(402)
    expect(verifyCalls).toBe(0)
  })

  test('rejects x402 route extensions with extra binding fields', async () => {
    let verifyCalls = 0
    const payment = ServerMppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.baseSepolia.USDC,
          recipient: accounts[0].address,
          x402: {
            facilitator: {
              async verify() {
                verifyCalls++
                return { isValid: true }
              },
              async settle(paymentPayload: Types.PaymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey,
    })
    const route = payment.evm.charge({ amount: '0.01' })

    const first = await route(new Request('https://example.com/a'))
    expect(first.status).toBe(402)
    if (first.status !== 402) throw new Error()

    const paymentRequired = Header.decodePaymentRequired(
      first.challenge.headers.get(Types.paymentRequiredHeader)!,
    )
    const accepted = paymentRequired.accepts[0]!
    const mppxExtension = paymentRequired.extensions!.mppx
    if (!mppxExtension) throw new Error()
    const extensions: Types.Extensions = {
      ...paymentRequired.extensions!,
      mppx: {
        schema: mppxExtension.schema,
        info: {
          ...mppxExtension.info,
          extra: 'not allowed',
        },
      },
    }
    const paymentSignature = Header.encodePaymentSignature({
      accepted,
      extensions,
      payload: {
        authorization: {
          from: accounts[0].address,
          nonce: RouteBinding.nonce({
            accepted,
            extensions,
            resource: paymentRequired.resource,
          }),
          to: accepted.payTo as `0x${string}`,
          validAfter: '0',
          validBefore: '9999999999',
          value: accepted.amount,
        },
        signature: `0x${'2'.repeat(130)}`,
      },
      resource: paymentRequired.resource,
      x402Version: 2,
    })

    const result = await route(
      new Request('https://example.com/a', {
        headers: { [Types.paymentSignatureHeader]: paymentSignature },
      }),
    )

    expect(result.status).toBe(402)
    expect(verifyCalls).toBe(0)
  })

  test('does not advertise x402 for body-bearing requests without a digest', async () => {
    let verifyCalls = 0
    const payment = ServerMppx.create({
      methods: [
        evm.charge({
          currency: evm.assets.baseSepolia.USDC,
          recipient: accounts[0].address,
          x402: {
            facilitator: {
              async verify() {
                verifyCalls++
                return { isValid: true }
              },
              async settle(paymentPayload: Types.PaymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey,
    })
    const route = payment.evm.charge({ amount: '0.01' })

    const result = await route(
      new Request('https://example.com/body', {
        body: JSON.stringify({ a: 1 }),
        method: 'POST',
      }),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.challenge.headers.has('WWW-Authenticate')).toBe(true)
    expect(result.challenge.headers.has(Types.paymentRequiredHeader)).toBe(false)

    const getChallenge = await route(new Request('https://example.com/body'))
    expect(getChallenge.status).toBe(402)
    if (getChallenge.status !== 402) throw new Error()
    const paymentRequired = Header.decodePaymentRequired(
      getChallenge.challenge.headers.get(Types.paymentRequiredHeader)!,
    )
    const accepted = paymentRequired.accepts[0]!
    const paymentSignature = Header.encodePaymentSignature({
      accepted,
      extensions: paymentRequired.extensions,
      payload: {
        authorization: {
          from: accounts[0].address,
          nonce: RouteBinding.nonce({
            accepted,
            extensions: paymentRequired.extensions!,
            resource: paymentRequired.resource,
          }),
          to: accepted.payTo as `0x${string}`,
          validAfter: '0',
          validBefore: '9999999999',
          value: accepted.amount,
        },
        signature: `0x${'2'.repeat(130)}`,
      },
      resource: paymentRequired.resource,
      x402Version: 2,
    })
    const replay = await route(
      new Request('https://example.com/body', {
        body: JSON.stringify({ a: 2 }),
        headers: { [Types.paymentSignatureHeader]: paymentSignature },
        method: 'POST',
      }),
    )
    expect(replay.status).toBe(402)
    expect(verifyCalls).toBe(0)
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
        evm.charge({
          currency: evm.assets.baseSepolia.USDC,
          recipient: accounts[0].address,
          x402: {
            facilitator: {
              async verify(paymentPayload: Types.PaymentPayload) {
                return {
                  isValid: true,
                  payer: payerOf(paymentPayload),
                }
              },
              async settle(paymentPayload: Types.PaymentPayload) {
                return {
                  network: paymentPayload.accepted.network,
                  payer: payerOf(paymentPayload),
                  success: true,
                  transaction,
                }
              },
            },
          },
        }),
      ],
      secretKey,
    })
    const paid = payment.compose(
      [payment.tempo.charge, { amount: '0', chainId: client.chain!.id }],
      [payment.evm.charge, { amount: '0.01' }],
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
          evmClient.charge({
            account: accounts[0],
          }),
        ],
        polyfill: false,
      })
      const paymentSignature = await x402ClientPayment.createCredential(
        pureX402Challenge(challenge),
      )
      const x402Response = await x402ClientPayment.rawFetch(server.url, {
        headers: { [Types.paymentSignatureHeader]: paymentSignature },
      })
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

function pureX402Challenge(response: Response): Response {
  const paymentRequired = response.headers.get(Types.paymentRequiredHeader)
  if (!paymentRequired) throw new Error('Missing PAYMENT-REQUIRED header.')
  return new Response(null, {
    headers: { [Types.paymentRequiredHeader]: paymentRequired },
    status: 402,
  })
}
