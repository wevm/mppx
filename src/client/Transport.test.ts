import { Challenge, Credential, Mcp } from 'mppx'
import { Transport } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vp/test'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const challenge = Challenge.fromMethod(Methods.charge, {
  realm,
  secretKey,
  expires: '2025-01-01T00:00:00.000Z',
  request: {
    amount: '0.001',
    currency: '0x20c0000000000000000000000000000000000001',
    decimals: 6,
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
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
      	  "expires": "2025-01-01T00:00:00.000Z",
      	  "id": "TYrS4_zjUdm9n_FV2wIZrWjIttldjjzjKoiSTRDteIs",
      	  "intent": "charge",
      	  "method": "tempo",
      	  "realm": "api.example.com",
      	  "request": {
      	    "amount": "1000",
      	    "currency": "0x20c0000000000000000000000000000000000001",
      	    "decimals": 6,
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
        `"Payment eyJjaGFsbGVuZ2UiOnsiZXhwaXJlcyI6IjIwMjUtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImlkIjoiVFlyUzRfempVZG05bl9GVjJ3SVpyV2pJdHRsZGpqempLb2lTVFJEdGVJcyIsImludGVudCI6ImNoYXJnZSIsIm1ldGhvZCI6InRlbXBvIiwicmVhbG0iOiJhcGkuZXhhbXBsZS5jb20iLCJyZXF1ZXN0IjoiZXlKaGJXOTFiblFpT2lJeE1EQXdJaXdpWTNWeWNtVnVZM2tpT2lJd2VESXdZekF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREVpTENKa1pXTnBiV0ZzY3lJNk5pd2ljbVZqYVhCcFpXNTBJam9pTUhnM05ESmtNelZEWXpZMk16UkRNRFV6TWpreU5XRXpZamcwTkVKak9XVTNOVGsxWmpobVJUQXdJbjAifSwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweGFiYzEyMyIsInR5cGUiOiJ0cmFuc2FjdGlvbiJ9fQ"`,
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
        result: { content: [] },
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
      	  "expires": "2025-01-01T00:00:00.000Z",
      	  "id": "TYrS4_zjUdm9n_FV2wIZrWjIttldjjzjKoiSTRDteIs",
      	  "intent": "charge",
      	  "method": "tempo",
      	  "realm": "api.example.com",
      	  "request": {
      	    "amount": "1000",
      	    "currency": "0x20c0000000000000000000000000000000000001",
      	    "decimals": 6,
      	    "description": undefined,
      	    "externalId": undefined,
      	    "methodDetails": {
      	      "chainId": undefined,
      	      "feePayer": undefined,
      	      "memo": undefined,
      	    },
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
        result: { content: [] },
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
      	  "method": "tools/call",
      	  "params": {
      	    "_meta": {
      	      "org.paymentauth/credential": {
      	        "challenge": {
      	          "expires": "2025-01-01T00:00:00.000Z",
      	          "id": "TYrS4_zjUdm9n_FV2wIZrWjIttldjjzjKoiSTRDteIs",
      	          "intent": "charge",
      	          "method": "tempo",
      	          "realm": "api.example.com",
      	          "request": {
      	            "amount": "1000",
      	            "currency": "0x20c0000000000000000000000000000000000001",
      	            "decimals": 6,
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
