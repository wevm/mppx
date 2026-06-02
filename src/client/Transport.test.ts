import { Challenge, Credential, Mcp } from 'mppx'
import { Transport } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { Header as x402_Header, Types as x402_Types, type PaymentRequired } from 'mppx/x402'
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

const x402PaymentRequired = {
  accepts: [
    {
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      maxTimeoutSeconds: 60,
      network: 'eip155:84532',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      scheme: x402_Types.schemes[0],
    },
  ],
  resource: {
    url: 'https://api.example.com/x402',
  },
  x402Version: 2,
} satisfies PaymentRequired

describe('http', () => {
  describe('isPaymentRequired', () => {
    test.each([
      { expected: true, status: 402 },
      { expected: false, status: 200 },
      { expected: false, status: 401 },
    ])('returns $expected for $status response', ({ expected, status }) => {
      const response = new Response(null, { status })

      const transport = Transport.http()
      expect(transport.isPaymentRequired(response)).toBe(expected)
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

      expect(transport.getChallenge(response)).toMatchObject({
        expires: '2025-01-01T00:00:00.000Z',
        id: expect.any(String),
        intent: 'charge',
        method: 'tempo',
        realm: 'api.example.com',
        request: {
          amount: '1000',
          currency: '0x20c0000000000000000000000000000000000001',
          recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        },
      })
    })

    test('throws for non-402 response', () => {
      const transport = Transport.http()
      const response = new Response(null, { status: 200 })

      expect(() => transport.getChallenge(response)).toThrow()
    })
  })

  describe('getChallenges', () => {
    test.each([
      {
        expectedIds: [challenge.id, 'alternate'],
        expectedMethods: ['tempo', 'stripe'],
        headers: () => ({
          'WWW-Authenticate': `${Challenge.serialize(challenge)}, ${Challenge.serialize({
            ...challenge,
            id: 'alternate',
            method: 'stripe' as const,
          })}`,
        }),
        name: 'Payment auth challenges',
      },
      {
        expectedIds: [`${x402_Types.syntheticChallengeIdPrefix}0`],
        expectedMethods: [x402_Types.paymentMethod],
        headers: () => ({
          'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
        }),
        name: 'x402 challenges',
      },
      {
        expectedIds: [
          `${x402_Types.syntheticChallengeIdPrefix}0`,
          `${x402_Types.syntheticChallengeIdPrefix}1`,
        ],
        expectedMethods: [x402_Types.paymentMethod, x402_Types.paymentMethod],
        headers: () => ({
          'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired({
            ...x402PaymentRequired,
            accepts: [
              x402PaymentRequired.accepts[0]!,
              {
                ...x402PaymentRequired.accepts[0]!,
                amount: '20000',
              },
            ],
          }),
        }),
        name: 'multiple x402 accepts',
      },
      {
        expectedIds: [challenge.id],
        expectedMethods: ['tempo'],
        headers: () => ({
          'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          'WWW-Authenticate': Challenge.serialize(challenge),
        }),
        name: 'Payment auth challenges when x402 is also present',
      },
    ])('returns $name', ({ expectedIds, expectedMethods, headers }) => {
      const transport = Transport.http()
      const response = new Response(null, {
        status: 402,
        headers: headers(),
      })
      const challenges = transport.getChallenges?.(response) ?? []

      expect(challenges.map((entry) => entry.id)).toEqual(expectedIds)
      expect(challenges.map((entry) => entry.method)).toEqual(expectedMethods)
    })
  })

  describe('setCredential', () => {
    test.each([
      {
        challenge,
        credential: Credential.serialize(credential),
        expectedHeader: 'Authorization',
        expectedValue: Credential.serialize(credential),
        name: 'Payment auth credential for Payment auth challenge',
      },
      {
        challenge: Transport.http().getChallenges!(
          new Response(null, {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
            },
          }),
        )[0],
        credential: 'x402-signature',
        expectedHeader: 'PAYMENT-SIGNATURE',
        expectedValue: 'x402-signature',
        name: 'raw x402 credential for x402 challenge',
      },
      {
        challenge,
        credential: 'custom-credential',
        expectedHeader: 'Authorization',
        expectedValue: 'custom-credential',
        name: 'non-Payment credential for non-x402 challenge',
      },
      {
        challenge: undefined,
        credential: 'custom-credential',
        expectedHeader: 'Authorization',
        expectedValue: 'custom-credential',
        name: 'credential without selected challenge',
      },
    ])('writes $name', ({ challenge, credential, expectedHeader, expectedValue }) => {
      const transport = Transport.http()

      const result = transport.setCredential({}, credential, { challenge })
      const headers = result.headers as Headers

      expect(headers.get(expectedHeader)).toBe(expectedValue)
    })

    test('does not treat unbranded Payment-auth challenges as x402', () => {
      const transport = Transport.http()
      const untrustedChallenge = Challenge.from({
        id: `${x402_Types.syntheticChallengeIdPrefix}0`,
        intent: x402_Types.exactIntent,
        method: x402_Types.paymentMethod,
        realm: 'api.example.com',
        request: x402PaymentRequired.accepts[0]!,
      })

      const result = transport.setCredential({}, 'credential', {
        challenge: untrustedChallenge,
      })
      const headers = result.headers as Headers

      expect(headers.get('Authorization')).toBe('credential')
      expect(headers.get(x402_Types.paymentSignatureHeader)).toBeNull()
    })

    test('removes stale credential headers before setting the retry credential', () => {
      const transport = Transport.http()
      const x402Challenge = Transport.http().getChallenges!(
        new Response(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          },
        }),
      )[0]

      const result = transport.setCredential(
        {
          headers: {
            Authorization: 'Payment stale',
            [x402_Types.paymentSignatureHeader]: 'stale-x402',
          },
        },
        'fresh-x402',
        { challenge: x402Challenge },
      )
      const headers = result.headers as Headers

      expect(headers.get('Authorization')).toBeNull()
      expect(headers.get(x402_Types.paymentSignatureHeader)).toBe('fresh-x402')
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

      expect(transport.getChallenge(response)).toMatchObject({
        expires: '2025-01-01T00:00:00.000Z',
        id: expect.any(String),
        intent: 'charge',
        method: 'tempo',
        realm: 'api.example.com',
        request: {
          amount: '1000',
          currency: '0x20c0000000000000000000000000000000000001',
          recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        },
      })
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

  describe('getChallenges', () => {
    test('returns all MCP challenges', () => {
      const transport = Transport.mcp()
      const response: Mcp.Response = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: {
            httpStatus: 402,
            challenges: [challenge, { ...challenge, id: 'alternate', method: 'stripe' }],
          },
        },
      }

      expect(transport.getChallenges?.(response).map((entry) => entry.id)).toEqual([
        challenge.id,
        'alternate',
      ])
    })
  })

  describe('setCredential', () => {
    test('default', () => {
      const transport = Transport.mcp()
      const serialized = Credential.serialize(credential)

      expect(transport.setCredential(mcpRequest, serialized)).toMatchObject({
        method: 'tools/call',
        params: {
          _meta: {
            'org.paymentauth/credential': {
              challenge: {
                expires: '2025-01-01T00:00:00.000Z',
                id: expect.any(String),
                intent: 'charge',
                method: 'tempo',
                realm: 'api.example.com',
                request: {
                  amount: '1000',
                  currency: '0x20c0000000000000000000000000000000000001',
                  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
                },
              },
              payload: {
                signature: '0xabc123',
                type: 'transaction',
              },
            },
          },
          name: 'test-tool',
        },
      })
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
