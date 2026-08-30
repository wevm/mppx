import { Readable } from 'node:stream'

import { describe, expect, test, vi } from 'vp/test'

import type { StripeClient } from '../../internal/types.js'
import * as HostedFeePayer from './hosted-fee-payer.js'

function createClient(request: (...args: any[]) => void): StripeClient {
  return {
    _requestSender: { _request: request },
    paymentIntents: {
      create: vi.fn(async () => ({ id: 'pi_mock', status: 'succeeded' })),
    },
    rawRequest: vi.fn(),
  }
}

function sendRequest(request: (...args: any[]) => void, body: unknown) {
  const feePayer = HostedFeePayer.create(createClient(request))
  return feePayer.fetch!(feePayer.url, {
    body: JSON.stringify(body),
    method: 'POST',
  })
}

describe('Stripe hosted fee payer', () => {
  test('forwards JSON-RPC through the configured Stripe client', async () => {
    const rpcRequest = {
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_fillTransaction',
      params: [{ from: '0xsender' }],
    }
    const request = vi.fn((...args: any[]) => {
      const data = args[3]
      const callback = args[7] as (error: unknown, response: unknown) => void
      const processData = args[8] as (
        method: string,
        data: unknown,
        headers: unknown,
        callback: (error: unknown, body: string) => void,
      ) => void

      processData('POST', data, {}, (error, body) => {
        expect(error).toBeNull()
        expect(JSON.parse(body)).toEqual(rpcRequest)
      })
      callback(
        null,
        Readable.from([
          JSON.stringify({ id: 1, jsonrpc: '2.0', result: { tx: { feeToken: '0xtoken' } } }),
        ]),
      )
    })
    const response = await sendRequest(request, rpcRequest)

    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: { tx: { feeToken: '0xtoken' } },
    })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.slice(0, 4)).toEqual([
      'POST',
      'mpp.stripe.com',
      '/tempo/feepayer',
      rpcRequest,
    ])
    expect(request.mock.calls[0]?.[4]).toBeNull()
    expect(request.mock.calls[0]?.[5]).toEqual({
      headers: { 'Content-Type': 'application/json' },
      settings: { maxNetworkRetries: 0 },
      streaming: true,
    })
  })

  test('returns Stripe request failures as JSON-RPC errors', async () => {
    const request = vi.fn((...args: any[]) => {
      const callback = args[7] as (error: unknown, response: unknown) => void
      callback(
        {
          code: -32602,
          message: 'unknown account',
          statusCode: 400,
        },
        null,
      )
    })
    const response = await sendRequest(request, {
      id: 7,
      jsonrpc: '2.0',
      method: 'eth_fillTransaction',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: -32602, message: 'unknown account' },
      id: 7,
      jsonrpc: '2.0',
    })
    expect(request).toHaveBeenCalledOnce()
  })
})
