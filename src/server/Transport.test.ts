import { Challenge, Credential, Mcp, Receipt } from 'mppx'
import { Transport } from 'mppx/server'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vp/test'

import { BadRequestError, ChannelClosedError } from '../Errors.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const challenge = Challenge.fromMethod(Methods.charge, {
  realm,
  secretKey,
  expires: '2025-01-01T00:00:00.000Z',
  request: {
    amount: '1000',
    currency: '0x20c0000000000000000000000000000000000001',
    decimals: 6,
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  },
})

const credential = Credential.from({
  challenge,
  payload: { signature: '0xabc123', type: 'transaction' },
})

const receipt = Receipt.from({
  method: 'tempo',
  status: 'success',
  timestamp: '2025-01-01T00:00:00.000Z',
  reference: '0xtxhash',
})

describe('http', () => {
  describe('getCredential', () => {
    test('returns credential from Authorization header', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Authorization: Credential.serialize(credential) },
      })

      expect(transport.getCredential(request)).toMatchInlineSnapshot(`
        {
          "challenge": {
            "expires": "2025-01-01T00:00:00.000Z",
            "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000000000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
            },
          },
          "payload": {
            "signature": "0xabc123",
            "type": "transaction",
          },
        }
      `)
    })

    test('returns null when no Authorization header', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')

      expect(transport.getCredential(request)).toBeNull()
    })

    test('returns null when no Payment scheme present', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Authorization: 'Bearer invalid' },
      })

      expect(transport.getCredential(request)).toBeNull()
    })
  })

  describe('respondChallenge', () => {
    test('default', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')

      const response = await transport.respondChallenge({ challenge, input: request })

      expect({
        status: response.status,
        headers: Object.fromEntries(response.headers),
      }).toMatchInlineSnapshot(`
        {
          "headers": {
            "cache-control": "no-store",
            "www-authenticate": "Payment id="QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAwMDAwIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJyZWNpcGllbnQiOiIweDc0MmQzNUNjNjYzNEMwNTMyOTI1YTNiODQ0QmM5ZTc1OTVmOGZFMDAifQ", expires="2025-01-01T00:00:00.000Z"",
          },
          "status": 402,
        }
      `)
    })
  })

  describe('respondChallenge with error status codes', () => {
    test('BadRequestError returns 400', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')
      const error = new BadRequestError({ reason: 'invalid parameters' })

      const response = await transport.respondChallenge({ challenge, input: request, error })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.type).toBe('https://paymentauth.org/problems/bad-request')
      expect(body.status).toBe(400)
    })

    test('ChannelClosedError returns 410', async () => {
      const transport = Transport.http()
      const request = new Request('https://example.com')
      const error = new ChannelClosedError({ reason: 'channel finalized' })

      const response = await transport.respondChallenge({ challenge, input: request, error })

      expect(response.status).toBe(410)
      const body = await response.json()
      expect(body.type).toBe('https://paymentauth.org/problems/session/channel-finalized')
      expect(body.status).toBe(410)
    })
  })

  describe('respondReceipt', () => {
    test('default', () => {
      const transport = Transport.http()
      const originalResponse = new Response('OK', { status: 200 })

      const response = transport.respondReceipt({
        receipt,
        response: originalResponse,
        challengeId: challenge.id,
      })

      expect({
        status: response.status,
        headers: Object.fromEntries(response.headers),
      }).toMatchInlineSnapshot(`
        {
          "headers": {
            "content-type": "text/plain;charset=UTF-8",
            "payment-receipt": "eyJtZXRob2QiOiJ0ZW1wbyIsInJlZmVyZW5jZSI6IjB4dHhoYXNoIiwic3RhdHVzIjoic3VjY2VzcyIsInRpbWVzdGFtcCI6IjIwMjUtMDEtMDFUMDA6MDA6MDAuMDAwWiJ9",
          },
          "status": 200,
        }
      `)
    })
  })
})

describe('mcp', () => {
  const mcpRequest: Mcp.JsonRpcRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'test-tool',
    },
  }

  describe('getCredential', () => {
    test('returns credential from _meta', () => {
      const transport = Transport.mcp()
      const request: Mcp.JsonRpcRequest = {
        ...mcpRequest,
        params: {
          ...mcpRequest.params,
          _meta: {
            [Mcp.credentialMetaKey]: credential,
          },
        },
      }

      expect(transport.getCredential(request)).toMatchInlineSnapshot(`
        {
          "challenge": {
            "expires": "2025-01-01T00:00:00.000Z",
            "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000000000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
            },
          },
          "payload": {
            "signature": "0xabc123",
            "type": "transaction",
          },
        }
      `)
    })

    test('returns null when no credential in _meta', () => {
      const transport = Transport.mcp()

      expect(transport.getCredential(mcpRequest)).toBeNull()
    })
  })

  describe('respondChallenge', () => {
    test('default', () => {
      const transport = Transport.mcp()

      expect(transport.respondChallenge({ challenge, input: mcpRequest })).toMatchInlineSnapshot(`
        {
          "error": {
            "code": -32042,
            "data": {
              "challenges": [
                {
                  "expires": "2025-01-01T00:00:00.000Z",
                  "id": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
                  "intent": "charge",
                  "method": "tempo",
                  "realm": "api.example.com",
                  "request": {
                    "amount": "1000000000",
                    "currency": "0x20c0000000000000000000000000000000000001",
                    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
                  },
                },
              ],
              "httpStatus": 402,
            },
            "message": "Payment Required",
          },
          "id": 1,
          "jsonrpc": "2.0",
        }
      `)
    })
  })

  describe('respondReceipt', () => {
    test('default', () => {
      const transport = Transport.mcp()
      const successResponse: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [] },
      }

      expect(
        transport.respondReceipt({ receipt, response: successResponse, challengeId: challenge.id }),
      ).toMatchInlineSnapshot(`
        {
          "id": 1,
          "jsonrpc": "2.0",
          "result": {
            "_meta": {
              "org.paymentauth/receipt": {
                "challengeId": "QNLtjAvrKKR0VlEGSIowhULqcGlCDU4fjrP-O7js8XE",
                "method": "tempo",
                "reference": "0xtxhash",
                "status": "success",
                "timestamp": "2025-01-01T00:00:00.000Z",
              },
            },
            "content": [],
          },
        }
      `)
    })

    test('returns error response unchanged', () => {
      const transport = Transport.mcp()
      const errorResponse: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      }

      expect(
        transport.respondReceipt({ receipt, response: errorResponse, challengeId: challenge.id }),
      ).toBe(errorResponse)
    })
  })
})
