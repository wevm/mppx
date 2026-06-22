import { Challenge, Credential, Mcp } from 'mppx'
import { Transport } from 'mppx/client'
import { Methods } from 'mppx/tempo'
import { Header as x402_Header, Types as x402_Types, type PaymentRequired } from 'mppx/x402'
import { describe, expect, test } from 'vp/test'

import * as x402_ChallengeBrand from '../x402/internal/ChallengeBrand.js'

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
        expectedIds: [challenge.id, `${x402_Types.syntheticChallengeIdPrefix}0`],
        expectedMethods: ['tempo', x402_Types.paymentMethod],
        headers: () => ({
          'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          'WWW-Authenticate': Challenge.serialize(challenge),
        }),
        name: 'Payment auth and x402 challenges when both are present',
      },
    ])('returns $name', async ({ expectedIds, expectedMethods, headers }) => {
      const transport = Transport.http()
      const response = new Response(null, {
        status: 402,
        headers: headers(),
      })
      const challenges = (await transport.getChallenges?.(response)) ?? []

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

    test('writes x402 credentials for x402 challenges from the same transport', () => {
      const transport = Transport.http()
      const [x402Challenge] = transport.getChallenges!(
        new Response(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          },
        }),
      ) as Challenge.Challenge[]

      const result = transport.setCredential({}, 'x402-signature', { challenge: x402Challenge })
      const headers = result.headers as Headers

      expect(headers.get('Authorization')).toBeNull()
      expect(headers.get(x402_Types.paymentSignatureHeader)).toBe('x402-signature')
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

    test('routes JSON-RPC requests with native 402 challenges through Authorization', () => {
      const transport = Transport.http()
      const jsonRpcRequest = {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
      } satisfies RequestInit
      const [nativeChallenge] = transport.getChallenges!(
        new Response(null, {
          status: 402,
          headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
        }),
        jsonRpcRequest,
      ) as Challenge.Challenge[]

      const result = transport.setCredential(jsonRpcRequest, 'credential', {
        challenge: nativeChallenge,
      })
      const headers = new Headers(result.headers)

      expect(headers.get('Authorization')).toBe('credential')
      expect(result.body).toBe(jsonRpcRequest.body)
    })

    test('marks x402 challenges with the brand the evm charge client reads', async () => {
      // Provenance guard: `evm/client/Charge.ts` recognizes x402 challenges via the same
      // brand the x402 adapter stamps. If the marking site drifts, EVM x402 charges misroute.
      const [x402Challenge] = await Transport.http().getChallenges!(
        new Response(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          },
        }),
      )
      expect(x402_ChallengeBrand.is(x402Challenge)).toBe(true)
    })

    test('removes stale credential headers before setting the retry credential', async () => {
      const transport = Transport.http()
      const [x402Challenge] = await transport.getChallenges!(
        new Response(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': x402_Header.encodePaymentRequired(x402PaymentRequired),
          },
        }),
      )

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

describe('http (MCP-over-HTTP)', () => {
  // An MCP-over-HTTP call: a JSON-RPC POST whose response carries the -32042 challenge.
  const jsonRpcRequest = {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'premium' },
    }),
  } satisfies RequestInit
  const errorMessage = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: Mcp.paymentRequiredCode,
      message: 'Payment Required',
      data: { challenges: [challenge] },
    },
  }
  const jsonBody = () =>
    new Response(JSON.stringify(errorMessage), { headers: { 'content-type': 'application/json' } })
  const sseBody = () =>
    new Response(`event: message\ndata: ${JSON.stringify(errorMessage)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })

  test('detects -32042 in a JSON body (JSON-RPC request)', async () => {
    expect(await Transport.http().isPaymentRequired(jsonBody(), jsonRpcRequest)).toBe(true)
  })
  test('ignores a JSON-RPC response for a different request id', async () => {
    const response = new Response(JSON.stringify({ ...errorMessage, id: 2 }), {
      headers: { 'content-type': 'application/json' },
    })

    expect(await Transport.http().isPaymentRequired(response, jsonRpcRequest)).toBe(false)
  })
  test('detects -32042 in an SSE body', async () => {
    expect(await Transport.http().isPaymentRequired(sseBody(), jsonRpcRequest)).toBe(true)
  })
  test('does not scan past the first SSE data event', async () => {
    const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: {} }
    const response = new Response(
      `event: message\ndata: ${JSON.stringify(notification)}\n\n` +
        `event: message\ndata: ${JSON.stringify(errorMessage)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )

    expect(await Transport.http().isPaymentRequired(response, jsonRpcRequest)).toBe(false)
  })
  test('detects -32042 in an open SSE stream without waiting for stream close', async () => {
    const encoder = new TextEncoder()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const openSse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`event: message\ndata: ${JSON.stringify(errorMessage)}\n\n`),
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )

    try {
      const result = await Promise.race([
        Transport.http().isPaymentRequired(openSse, jsonRpcRequest),
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), 100)
        }),
      ])

      expect(result).toBe(true)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })
  test('does not read the body for a non-JSON-RPC request', async () => {
    expect(
      await Transport.http().isPaymentRequired(sseBody(), { method: 'POST', body: 'plain' }),
    ).toBe(false)
  })
  test('does not treat generic JSON-RPC as MCP-over-HTTP', async () => {
    const request = {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }),
    } satisfies RequestInit

    expect(await Transport.http().isPaymentRequired(sseBody(), request)).toBe(false)
  })
  test('ignores a 200 success', async () => {
    const ok = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      headers: { 'content-type': 'application/json' },
    })
    expect(await Transport.http().isPaymentRequired(ok, jsonRpcRequest)).toBe(false)
  })
  test('getChallenges extracts the MCP challenge (via the mcp protocol)', async () => {
    const challenges = await Transport.http().getChallenges!(sseBody(), jsonRpcRequest)
    expect(challenges.map((entry) => entry.id)).toEqual([challenge.id])
  })
  test('setCredential routes the MCP challenge into the JSON-RPC _meta', async () => {
    const transport = Transport.http()
    const [mcpChallenge] = await transport.getChallenges!(sseBody(), jsonRpcRequest)
    const result = transport.setCredential(jsonRpcRequest, Credential.serialize(credential), {
      challenge: mcpChallenge,
    }) as RequestInit
    const parsed = JSON.parse(result.body as string)
    expect(parsed.params['_meta'][Mcp.credentialMetaKey]).toMatchObject({
      payload: { type: 'transaction' },
    })
  })
  test('detects -32042 in a JSON body containing a "data:" substring', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: Mcp.paymentRequiredCode,
        message: 'Payment Required',
        data: { challenges: [{ ...challenge, realm: 'data:text/plain,x' }] },
      },
    })
    const response = new Response(body, { headers: { 'content-type': 'application/json' } })
    expect(await Transport.http().isPaymentRequired(response, jsonRpcRequest)).toBe(true)
  })
  test('ignores malformed payment challenge data', async () => {
    const response = new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: Mcp.paymentRequiredCode,
          message: 'Payment Required',
          data: { challenges: [{ ...challenge, realm: undefined }] },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    )

    expect(await Transport.http().isPaymentRequired(response, jsonRpcRequest)).toBe(false)
  })
  test('detects -32042 for any JSON-RPC method (no method allowlist)', async () => {
    const request = {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'custom/paidMethod', params: {} }),
    } satisfies RequestInit
    expect(await Transport.http().isPaymentRequired(sseBody(), request)).toBe(true)
  })
})

describe('mcp', () => {
  const mcpRequest: Mcp.Request = {
    method: 'tools/call',
    params: {
      name: 'test-tool',
    },
  }

  const mcpResponse: Mcp.Response = {
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

  test('extracts payment-required challenges from JSON-RPC errors', async () => {
    const transport = Transport.mcp()

    expect(await transport.isPaymentRequired(mcpResponse)).toBe(true)
    expect((await transport.getChallenges?.(mcpResponse))?.map((entry) => entry.id)).toEqual([
      challenge.id,
    ])
  })

  test('sets credentials in JSON-RPC _meta', () => {
    const result = Transport.mcp().setCredential(mcpRequest, Credential.serialize(credential))

    expect(result.params?.['_meta']?.[Mcp.credentialMetaKey]).toMatchObject({
      payload: {
        type: 'transaction',
      },
    })
  })
})
