import { describe, expect, test } from 'vitest'
import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as Receipt from '../Receipt.js'
import * as Intents from '../tempo/Intents.js'
import * as Transport from './Transport.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const challenge = Challenge.fromIntent(Intents.charge, {
  realm,
  secretKey,
  request: {
    amount: '1000',
    currency: '0x20c0000000000000000000000000000000000001',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    expires: '2025-01-01T00:00:00.000Z',
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
            "id": "4a55RMtPVF5Gvy4MgfQ7V9kd6HV4DsjD03YvnUuQaVQ",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "expires": "2025-01-01T00:00:00.000Z",
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

    test('throws for invalid credential', () => {
      const transport = Transport.http()
      const request = new Request('https://example.com', {
        headers: { Authorization: 'Bearer invalid' },
      })

      expect(() => transport.getCredential(request)).toThrow('Missing Payment scheme')
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
            "www-authenticate": "Payment id="4a55RMtPVF5Gvy4MgfQ7V9kd6HV4DsjD03YvnUuQaVQ", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJleHBpcmVzIjoiMjAyNS0wMS0wMVQwMDowMDowMC4wMDBaIiwicmVjaXBpZW50IjoiMHg3NDJkMzVDYzY2MzRDMDUzMjkyNWEzYjg0NEJjOWU3NTk1ZjhmRTAwIn0"",
          },
          "status": 402,
        }
      `)
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
            "id": "4a55RMtPVF5Gvy4MgfQ7V9kd6HV4DsjD03YvnUuQaVQ",
            "intent": "charge",
            "method": "tempo",
            "realm": "api.example.com",
            "request": {
              "amount": "1000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "expires": "2025-01-01T00:00:00.000Z",
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
                  "id": "4a55RMtPVF5Gvy4MgfQ7V9kd6HV4DsjD03YvnUuQaVQ",
                  "intent": "charge",
                  "method": "tempo",
                  "realm": "api.example.com",
                  "request": {
                    "amount": "1000",
                    "currency": "0x20c0000000000000000000000000000000000001",
                    "expires": "2025-01-01T00:00:00.000Z",
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
                "challengeId": "4a55RMtPVF5Gvy4MgfQ7V9kd6HV4DsjD03YvnUuQaVQ",
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
