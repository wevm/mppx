import { describe, expect, test } from 'vitest'
import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
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

describe('http', () => {
  describe('isPaymentRequired', () => {
    test('returns true for 402 response', () => {
      const transport = Transport.http()
      const response = new Response(null, { status: 402 })

      expect(transport.isPaymentRequired(response)).toBe(true)
    })

    test('returns false for 200 response', () => {
      const transport = Transport.http()
      const response = new Response(null, { status: 200 })

      expect(transport.isPaymentRequired(response)).toBe(false)
    })

    test('returns false for other error responses', () => {
      const transport = Transport.http()
      const response = new Response(null, { status: 401 })

      expect(transport.isPaymentRequired(response)).toBe(false)
    })
  })

  describe('getChallenge', () => {
    test('default', () => {
      const transport = Transport.http()
      const response = new Response(null, {
        status: 402,
        headers: {
          'WWW-Authenticate': Challenge.serialize(challenge),
        },
      })

      expect(transport.getChallenge(response)).toMatchInlineSnapshot(`
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
        }
      `)
    })

    test('throws for non-402 response', () => {
      const transport = Transport.http()
      const response = new Response(null, { status: 200 })

      expect(() => transport.getChallenge(response)).toThrow()
    })
  })

  describe('setCredential', () => {
    test('default', () => {
      const transport = Transport.http()
      const serialized = Credential.serialize(credential)

      const result = transport.setCredential({}, serialized)
      const headers = result.headers as Headers

      expect(headers.get('Authorization')).toMatchInlineSnapshot(
        `"Payment eyJjaGFsbGVuZ2UiOnsiaWQiOiI0YTU1Uk10UFZGNUd2eTRNZ2ZRN1Y5a2Q2SFY0RHNqRDAzWXZuVXVRYVZRIiwiaW50ZW50IjoiY2hhcmdlIiwibWV0aG9kIjoidGVtcG8iLCJyZWFsbSI6ImFwaS5leGFtcGxlLmNvbSIsInJlcXVlc3QiOiJleUpoYlc5MWJuUWlPaUl4TURBd0lpd2lZM1Z5Y21WdVkza2lPaUl3ZURJd1l6QXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01ERWlMQ0psZUhCcGNtVnpJam9pTWpBeU5TMHdNUzB3TVZRd01Eb3dNRG93TUM0d01EQmFJaXdpY21WamFYQnBaVzUwSWpvaU1IZzNOREprTXpWRFl6WTJNelJETURVek1qa3lOV0V6WWpnME5FSmpPV1UzTlRrMVpqaG1SVEF3SW4wIn0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHhhYmMxMjMiLCJ0eXBlIjoidHJhbnNhY3Rpb24ifX0"`,
      )
    })

    test('preserves existing headers', () => {
      const transport = Transport.http()
      const serialized = Credential.serialize(credential)

      const result = transport.setCredential(
        { headers: { 'Content-Type': 'application/json' } },
        serialized,
      )
      const headers = result.headers as Headers

      expect(headers.get('Content-Type')).toBe('application/json')
    })
  })
})

describe('mcp', () => {
  const mcpRequest: Mcp.Request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'test-tool',
    },
  }

  describe('isPaymentRequired', () => {
    test('returns true for payment required error', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: {
            httpStatus: 402,
            challenges: [challenge],
          },
        },
      }

      expect(transport.isPaymentRequired(response)).toBe(true)
    })

    test('returns false for success response', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: 'test' },
      }

      expect(transport.isPaymentRequired(response)).toBe(false)
    })

    test('returns false for other error codes', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      }

      expect(transport.isPaymentRequired(response)).toBe(false)
    })
  })

  describe('getChallenge', () => {
    test('default', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: {
            httpStatus: 402,
            challenges: [challenge],
          },
        },
      }

      expect(transport.getChallenge(response)).toMatchInlineSnapshot(`
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
        }
      `)
    })

    test('throws for success response', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: 'test' },
      }

      expect(() => transport.getChallenge(response)).toThrow('Response is not an error')
    })

    test('throws when no challenges in error', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: {
            httpStatus: 402,
            challenges: [],
          },
        },
      }

      expect(() => transport.getChallenge(response)).toThrow('No challenge in error response')
    })
  })

  describe('setCredential', () => {
    test('default', () => {
      const transport = Transport.mcp()
      const serialized = Credential.serialize(credential)

      expect(transport.setCredential(mcpRequest, serialized)).toMatchInlineSnapshot(`
        {
          "id": 1,
          "jsonrpc": "2.0",
          "method": "tools/call",
          "params": {
            "_meta": {
              "org.paymentauth/credential": {
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
              },
            },
            "name": "test-tool",
          },
        }
      `)
    })

    test('preserves existing _meta', () => {
      const transport = Transport.mcp()
      const serialized = Credential.serialize(credential)
      const requestWithMeta: Mcp.Request = {
        ...mcpRequest,
        params: {
          ...mcpRequest.params,
          _meta: {
            existingKey: 'existingValue',
          },
        },
      }

      const result = transport.setCredential(requestWithMeta, serialized)

      expect(result.params?._meta?.existingKey).toBe('existingValue')
    })
  })
})
