import { Hash, Hex, Json, Bytes } from 'ox'
import { afterEach, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as Mppx from '../../server/Mppx.js'
import { tempo } from './Methods.js'

const apiBaseUrl = 'https://relay.example'
const realm = 'api.example.com'
const secretKey = 'test-secret-key-test-secret-key-32'

const credential = {
  challenge: {
    id: 'challenge_123',
    intent: 'charge',
    method: 'tempo',
    realm,
    request: { amount: '100', currency: '0x123', recipient: '0x456' },
  },
  payload: { signature: '0x1234', type: 'transaction' },
  source: 'did:pkh:eip155:42431:0x123',
} as const

const pushedPayload = {
  hash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
  type: 'hash',
} as const

type RelayHandler = (url: URL, init: RequestInit) => Response | Promise<Response>

function mockRelay(handler: RelayHandler): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(input.toString())
    return handler(url, init ?? {})
  }) as typeof globalThis.fetch
}

function methods(fetch: typeof globalThis.fetch, url = apiBaseUrl) {
  return tempo({
    currency: '0x123',
    recipient: '0x456',
    relay: { apiBaseUrl: url, apiKey: 'tempo_api_key', fetch },
  })
}

function successReceipt() {
  return Response.json({
    receipt: {
      externalId: 'order_123',
      method: 'tempo',
      reference: '0xabc',
      timestamp: '2026-07-22T00:00:00.000Z',
    },
    success: true,
  })
}

async function createPaymentServer(
  fetch: typeof globalThis.fetch,
  payload: typeof credential.payload | typeof pushedPayload = credential.payload,
) {
  const [method] = methods(fetch, apiBaseUrl)
  const mppx = Mppx.create({ methods: [method], realm, secretKey })
  const handle = mppx.tempo.charge({ amount: '1', decimals: 6 })
  const server = await Http.createServer(async (request, response) => {
    const result = await Mppx.toNodeListener(handle)(request, response)
    if (result.status !== 402) response.end('OK')
  })

  const challengeResponse = await globalThis.fetch(server.url)
  const challenge = Challenge.fromResponse(challengeResponse)
  const paymentCredential = Credential.from({
    challenge,
    payload,
    source: credential.source,
  })

  return {
    pay: () =>
      globalThis.fetch(server.url, {
        headers: { Authorization: Credential.serialize(paymentCredential) },
      }),
    server,
  }
}

function expectGenericFailure(error: unknown) {
  expect(error).toMatchObject({
    name: 'VerificationFailedError',
    message: 'Payment verification failed.',
  })
  expect(error).not.toMatchObject({ details: expect.anything() })
  return true
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('relay boundary', () => {
  test('sends the complete credential to the configured validation endpoint', async () => {
    const fetch = mockRelay(() => Response.json({ success: true }))
    const [method, session] = methods(fetch)

    const result = await method.validate!({
      credential,
      request: { amount: '1', currency: '0x123', decimals: 6, recipient: '0x456' },
    } as never)

    expect(result).toMatchObject({
      challenge: credential.challenge,
      credential,
      details: {},
      intent: 'charge',
      method: 'tempo',
      request: credential.challenge.request,
      source: credential.source,
    })
    expect(session.intent).toBe('session')
    expect(fetch).toHaveBeenCalledWith(
      new URL(`${apiBaseUrl}/v1/mpp/validate`),
      expect.objectContaining({
        body: JSON.stringify(credential),
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json',
          'tempo-api-key': 'tempo_api_key',
        },
        method: 'POST',
      }),
    )
  })

  test('uses the default Tempo API base URL and omits an absent source', async () => {
    const fetch = mockRelay(() => Response.json({ success: true }))
    const [method] = tempo({
      currency: '0x123',
      recipient: '0x456',
      relay: { apiKey: 'tempo_api_key', fetch },
    })
    const sourceLessCredential = { ...credential, source: undefined }

    await method.validate!({
      credential: sourceLessCredential,
      request: credential.challenge.request,
    } as never)

    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.tempo.xyz/v1/mpp/validate'),
      expect.objectContaining({
        body: JSON.stringify({
          challenge: credential.challenge,
          payload: credential.payload,
        }),
      }),
    )
  })

  test('preserves a configured API base path', async () => {
    const fetch = mockRelay(() => Response.json({ success: true }))
    const [method] = methods(fetch, 'https://relay.example/mpp')

    await method.validate!({ credential, request: credential.challenge.request } as never)

    expect(fetch).toHaveBeenCalledWith(
      new URL('https://relay.example/mpp/v1/mpp/validate'),
      expect.anything(),
    )
  })

  test('broadcasts a valid relay receipt and forwards its external ID', async () => {
    const calls: Array<{ init: RequestInit; url: URL }> = []
    const fetch = mockRelay((url, init) => {
      calls.push({ init, url })
      return successReceipt()
    })
    const [method] = methods(fetch)

    await expect(
      method.broadcast!({ credential, request: credential.challenge.request } as never),
    ).resolves.toEqual({
      externalId: 'order_123',
      method: 'tempo',
      reference: '0xabc',
      status: 'success',
      timestamp: '2026-07-22T00:00:00.000Z',
    })
    expect(calls).toEqual([
      {
        init: expect.objectContaining({
          body: JSON.stringify(credential),
          headers: expect.objectContaining({
            Accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': expect.stringMatching(/^mppx_0x/),
            'tempo-api-key': 'tempo_api_key',
          }),
          method: 'POST',
        }),
        url: new URL(`${apiBaseUrl}/v1/mpp/broadcast`),
      },
    ])
  })

  test('delegates pushed transaction finalization to the relay', async () => {
    const calls: Array<{ init: RequestInit; url: URL }> = []
    const fetch = mockRelay((url, init) => {
      calls.push({ init, url })
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : successReceipt()
    })
    const [method] = methods(fetch)
    const pushedCredential = { ...credential, payload: pushedPayload }

    await expect(
      method.verify({
        credential: pushedCredential,
        request: credential.challenge.request,
      } as never),
    ).resolves.toMatchObject({
      method: 'tempo',
      reference: '0xabc',
      status: 'success',
    })
    expect(calls).toEqual([
      expect.objectContaining({ url: new URL(`${apiBaseUrl}/v1/mpp/validate`) }),
      expect.objectContaining({
        init: expect.objectContaining({ body: JSON.stringify(pushedCredential) }),
        url: new URL(`${apiBaseUrl}/v1/mpp/broadcast`),
      }),
    ])
  })

  test('validates a pushed transaction before returning its receipt', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : successReceipt()
    })
    const [method] = methods(fetch)
    const pushedCredential = {
      ...credential,
      challenge: {
        ...credential.challenge,
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      payload: pushedPayload,
    }

    await expect(
      Method.broadcastCredential([method], pushedCredential as never),
    ).resolves.toMatchObject({
      method: 'tempo',
      reference: '0xabc',
      status: 'success',
    })

    expect(calls).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast'])
  })

  test('uses the transaction hash as the transaction broadcast idempotency key', async () => {
    const calls: RequestInit[] = []
    const fetch = mockRelay((_url, init) => {
      calls.push(init)
      return successReceipt()
    })
    const [method] = methods(fetch)

    await method.broadcast!({ credential, request: credential.challenge.request } as never)
    await method.broadcast!({ credential, request: credential.challenge.request } as never)
    await method.broadcast!({
      credential: { ...credential, payload: { signature: '0x5678', type: 'transaction' } },
      request: credential.challenge.request,
    } as never)

    const keys = calls.map((init) => (init.headers as Record<string, string>)['idempotency-key'])
    expect(keys).toEqual([
      `mppx_${Hash.keccak256(Hex.toBytes(credential.payload.signature), { as: 'Hex' })}`,
      `mppx_${Hash.keccak256(Hex.toBytes(credential.payload.signature), { as: 'Hex' })}`,
      `mppx_${Hash.keccak256(Hex.toBytes('0x5678'), { as: 'Hex' })}`,
    ])
  })

  test('uses a canonical credential hash for non-transaction broadcasts', async () => {
    const calls: RequestInit[] = []
    const fetch = mockRelay((_url, init) => {
      calls.push(init)
      return successReceipt()
    })
    const [method] = methods(fetch)
    const proofCredential = {
      ...credential,
      payload: { proof: 'proof_123', type: 'proof' },
    }

    await method.broadcast!({
      credential: proofCredential,
      request: credential.challenge.request,
    } as never)

    const headers = calls[0]!.headers as Record<string, string>
    const expected = Hash.sha256(
      Bytes.fromString(
        Json.canonicalize({
          challenge: proofCredential.challenge,
          payload: proofCredential.payload,
          source: proofCredential.source,
        }),
      ),
      { as: 'Hex' },
    )
    expect(headers['idempotency-key']).toBe(`mppx_${expected}`)
  })

  test('preserves the legacy combined verify hook', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : successReceipt()
    })
    const [method] = methods(fetch)

    await expect(
      method.verify({ credential, request: credential.challenge.request } as never),
    ).resolves.toMatchObject({ method: 'tempo', status: 'success' })
    expect(calls).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast'])
  })

  test.each([
    ['validate', () => Promise.reject(new TypeError('relay DNS failure'))],
    [
      'validate',
      () =>
        Response.json(
          { error: { code: 'policy_denied', message: 'private detail' } },
          { status: 403 },
        ),
    ],
    ['validate', () => new Response('not JSON')],
    [
      'validate',
      () =>
        Response.json({
          error: { code: 'policy_denied', message: 'private detail' },
          success: false,
        }),
    ],
    ['broadcast', () => Promise.reject(new TypeError('relay DNS failure'))],
    [
      'broadcast',
      () =>
        Response.json(
          { error: { code: 'settlement_failed', message: 'private detail' } },
          { status: 500 },
        ),
    ],
    ['broadcast', () => new Response('not JSON')],
    [
      'broadcast',
      () =>
        Response.json({
          error: { code: 'settlement_failed', message: 'private detail' },
          success: false,
        }),
    ],
    ['broadcast', () => Response.json({ receipt: { method: 'tempo' }, success: true })],
    [
      'broadcast',
      () =>
        Response.json({
          receipt: {
            method: 'stripe',
            reference: '0xabc',
            timestamp: '2026-07-22T00:00:00.000Z',
          },
          success: true,
        }),
    ],
    [
      'broadcast',
      () =>
        Response.json({
          receipt: { method: 'tempo', reference: '0xabc', timestamp: 'not a timestamp' },
          success: true,
        }),
    ],
  ] as const)('maps %s boundary failure to a generic payment error', async (operation, respond) => {
    const fetch = mockRelay(() => respond())
    const [method] = methods(fetch)
    const invoke =
      operation === 'validate'
        ? method.validate!({ credential, request: credential.challenge.request } as never)
        : method.broadcast!({ credential, request: credential.challenge.request } as never)

    await expect(invoke).rejects.toSatisfy(expectGenericFailure)
  })

  test.each([
    ['already_used', { code: 'already_used' }],
    ['broadcast_failed', { code: 'broadcast_failed' }],
    ['invalid_payment', { code: 'invalid_payment' }],
    ['insufficient_funds', { code: 'insufficient_funds' }],
    ['simulation_failed', { code: 'simulation_failed' }],
    ['unsupported', { code: 'unsupported' }],
    ['temporarily_unavailable', { code: 'temporarily_unavailable', retry: 'same_credential' }],
  ] as const)('exposes the safe %s code', async (code, details) => {
    const fetch = mockRelay(() =>
      Response.json({ error: { code, message: 'Tempo API private message.' }, success: false }),
    )
    const [method] = methods(fetch, apiBaseUrl)

    try {
      await method.validate!({ credential, request: credential.challenge.request } as never)
      throw new Error('Expected validation to fail.')
    } catch (error) {
      expect(error).toMatchObject({
        details,
        message: 'Payment verification failed.',
        name: 'VerificationFailedError',
      })
      expect(error).not.toMatchObject({
        message: expect.stringContaining('Tempo API private message.'),
      })
    }
  })

  test('maps an expired relay response to payment-expired', async () => {
    const fetch = mockRelay(() =>
      Response.json({
        error: { code: 'expired', message: 'Tempo API private message.' },
        success: false,
      }),
    )
    const [method] = methods(fetch, apiBaseUrl)

    await expect(
      method.validate!({ credential, request: credential.challenge.request } as never),
    ).rejects.toMatchObject({
      details: undefined,
      message: 'Payment has expired.',
      name: 'PaymentExpiredError',
      type: 'https://paymentauth.org/problems/payment-expired',
    })
  })

  test.each(['policy_denied', 'screen_rejected', 'unknown'] as const)(
    'keeps the sensitive %s code opaque',
    async (code) => {
      const fetch = mockRelay(() =>
        Response.json({ error: { code, message: 'Tempo API private message.' }, success: false }),
      )
      const [method] = methods(fetch, apiBaseUrl)

      await expect(
        method.validate!({ credential, request: credential.challenge.request } as never),
      ).rejects.toSatisfy(expectGenericFailure)
    },
  )

  test('keeps non-2xx Tempo API responses opaque', async () => {
    const fetch = mockRelay(() =>
      Response.json(
        { error: { code: 'insufficient_funds', message: 'Tempo API private message.' } },
        { status: 403 },
      ),
    )
    const [method] = methods(fetch, apiBaseUrl)

    await expect(
      method.validate!({ credential, request: credential.challenge.request } as never),
    ).rejects.toSatisfy(expectGenericFailure)
  })
})

describe('relay HTTP flow', () => {
  test('validates, broadcasts, and returns a payment receipt', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : successReceipt()
    })
    const { pay, server } = await createPaymentServer(fetch)

    try {
      const response = await pay()
      expect(response.status).toBe(200)
      expect(response.headers.get('Payment-Receipt')).toBeTruthy()
      expect(calls).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast'])
    } finally {
      server.close()
    }
  })

  test('delegates pushed transaction finalization to the relay', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : successReceipt()
    })
    const { pay, server } = await createPaymentServer(fetch, pushedPayload)

    try {
      const response = await pay()

      expect(response.status).toBe(200)
      expect(Receipt.fromResponse(response)).toMatchObject({
        method: 'tempo',
        reference: '0xabc',
        status: 'success',
      })
      expect(calls).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast'])
    } finally {
      server.close()
    }
  })

  test('does not issue a receipt when relay validation rejects a pushed transaction', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return Response.json({
        error: { code: 'policy_denied', message: 'private detail' },
        success: false,
      })
    })
    const { pay, server } = await createPaymentServer(fetch, pushedPayload)

    try {
      const response = await pay()
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(402)
      expect(response.headers.get('Payment-Receipt')).toBeNull()
      expect(body).toMatchObject({
        detail: 'Payment verification failed.',
        type: 'https://paymentauth.org/problems/verification-failed',
      })
      expect(JSON.stringify(body)).not.toContain('policy_denied')
      expect(JSON.stringify(body)).not.toContain('private detail')
      expect(calls).toEqual(['/v1/mpp/validate'])
    } finally {
      server.close()
    }
  })

  test('does not issue a receipt when relay finalization rejects a pushed transaction', async () => {
    const calls: string[] = []
    const fetch = mockRelay((url) => {
      calls.push(url.pathname)
      return url.pathname === '/v1/mpp/validate'
        ? Response.json({ success: true })
        : Response.json({
            error: { code: 'already_used', message: 'private detail' },
            success: false,
          })
    })
    const { pay, server } = await createPaymentServer(fetch, pushedPayload)

    try {
      const response = await pay()
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(402)
      expect(response.headers.get('Payment-Receipt')).toBeNull()
      expect(body).toMatchObject({
        detail: 'Payment verification failed.',
        details: { code: 'already_used' },
        type: 'https://paymentauth.org/problems/verification-failed',
      })
      expect(JSON.stringify(body)).not.toContain('private detail')
      expect(calls).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast'])
    } finally {
      server.close()
    }
  })

  test.each([
    ['validation network failure', () => Promise.reject(new TypeError('tempo api unavailable')), 1],
    [
      'validation rejection',
      () =>
        Response.json({
          error: { code: 'policy_denied', message: 'private detail' },
          success: false,
        }),
      1,
    ],
    ['broadcast network failure', () => Promise.reject(new TypeError('tempo api unavailable')), 2],
    [
      'broadcast rejection',
      () =>
        Response.json({
          error: { code: 'settlement_failed', message: 'private detail' },
          success: false,
        }),
      2,
    ],
    [
      'malformed broadcast receipt',
      () => Response.json({ receipt: { method: 'tempo' }, success: true }),
      2,
    ],
  ] as const)('returns an opaque 402 for %s', async (_name, failure, expectedCalls) => {
    let call = 0
    const fetch = mockRelay(() => {
      call += 1
      if (call === expectedCalls) return failure()
      return Response.json({ success: true })
    })
    const { pay, server } = await createPaymentServer(fetch)

    try {
      const response = await pay()
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(402)
      expect(response.headers.get('WWW-Authenticate')).toContain('Payment')
      expect(response.headers.get('Payment-Receipt')).toBeNull()
      expect(response.headers.get('Content-Type')).toContain('application/problem+json')
      expect(body).toMatchObject({
        challengeId: expect.any(String),
        detail: 'Payment verification failed.',
        status: 402,
        title: 'Verification Failed',
        type: 'https://paymentauth.org/problems/verification-failed',
      })
      expect(JSON.stringify(body)).not.toContain('tempo api unavailable')
      expect(JSON.stringify(body)).not.toContain('policy_denied')
      expect(JSON.stringify(body)).not.toContain('settlement_failed')
      expect(JSON.stringify(body)).not.toContain('private detail')
      expect(JSON.stringify(body)).not.toContain(apiBaseUrl)
      expect(JSON.stringify(body)).not.toContain('tempo_api_key')
      expect(call).toBe(expectedCalls)
    } finally {
      server.close()
    }
  })

  test('includes a safe relay code in the 402 problem details', async () => {
    const fetch = mockRelay(() =>
      Response.json({
        error: { code: 'temporarily_unavailable', message: 'Tempo API private message.' },
        success: false,
      }),
    )
    const { pay, server } = await createPaymentServer(fetch)

    try {
      const response = await pay()
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(402)
      expect(body).toMatchObject({
        detail: 'Payment verification failed.',
        details: { code: 'temporarily_unavailable', retry: 'same_credential' },
        type: 'https://paymentauth.org/problems/verification-failed',
      })
      expect(JSON.stringify(body)).not.toContain('Tempo API private message.')
      expect(JSON.stringify(body)).not.toContain(apiBaseUrl)
    } finally {
      server.close()
    }
  })
})
