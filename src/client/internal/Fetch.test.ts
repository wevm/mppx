import { Challenge, Credential, Errors, Mcp, Method, Receipt, z } from 'mppx'
import { evm, tempo } from 'mppx/client'
import {
  Mppx as Mppx_server,
  tempo as tempo_server,
  Transport as Transport_server,
} from 'mppx/server'
import { Header as x402_Header, Types as x402_Types, type PaymentRequired } from 'mppx/x402'
import { Base64 } from 'ox'
import type { Account } from 'viem'
import { createClient, defineChain } from 'viem'
import { describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/rpc.js'
import { accounts, asset, chain, client, http } from '~test/tempo/viem.js'

import * as Fetch from './Fetch.js'
import * as MethodChallenge from './MethodChallenge.js'
import * as MethodResponse from './MethodResponse.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key-test-secret-key-32'

const server = Mppx_server.create({
  methods: [
    tempo_server({
      chainId: client.chain.id,
      getClient: () => client,
      account: accounts[0],
    }),
  ],
  realm,
  secretKey,
})

describe('Fetch.from', () => {
  test('default: account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "fundingCurrency": "0x20c0000000000000000000000000000000000001",
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
  })

  test('default: account via context', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')

    httpServer.close()
  })

  test('behavior: context overrides account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[0],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    httpServer.close()
  })

  test('behavior: throws when no account provided', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => createClient({ chain, transport: http() }),
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    await expect(fetch(httpServer.url)).rejects.toThrow(
      'No `account` provided. Pass `account` to parameters or context.',
    )

    httpServer.close()
  })

  test('behavior: passes through non-402 responses', async () => {
    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')

    httpServer.close()
  })

  test('behavior: fee payer', async () => {
    const serverWithFeePayer = Mppx_server.create({
      methods: [
        tempo_server.charge({
          chainId: chain.id,
          feePayer: accounts[0],
          getClient: () => client,
        }),
      ],
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        serverWithFeePayer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "fundingCurrency": "0x20c0000000000000000000000000000000000001",
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
  })

  test('behavior: fee payer with plain chain client (no Tempo serializers)', async () => {
    const plainChain = defineChain({
      id: chain.id,
      name: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: chain.rpcUrls,
    })
    const plainClient = createClient({
      account: accounts[1],
      chain: plainChain,
      transport: http(rpcUrl),
    })

    const serverWithFeePayer = Mppx_server.create({
      methods: [
        tempo_server.charge({
          chainId: chain.id,
          feePayer: accounts[0],
          getClient: () => client,
        }),
      ],
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => plainClient,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        serverWithFeePayer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')

    httpServer.close()
  })

  test('behavior: onChallenge can create credential', async () => {
    const onChallenge = vi.fn(async (_challenge, { createCredential }) =>
      createCredential({ account: accounts[1] }),
    )

    const fetch = Fetch.from({
      methods: [
        tempo.charge({
          getClient: () => client,
        }),
      ],
      onChallenge,
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(onChallenge).toHaveBeenCalledTimes(1)

    httpServer.close()
  })
})

// Minimal mock method — createCredential is only invoked on the 402 retry path.
const noopMethod = {
  name: 'test',
  intent: 'test',
  context: undefined,
  createCredential: async () => 'credential',
} as any

function trackedMethod(settlements: MethodResponse.AttemptOutcome['status'][]) {
  const method = {
    ...noopMethod,
    async createCredential(parameters: object) {
      const attempt = MethodResponse.getAttempt(parameters)
      if (attempt)
        attempt.settle = (outcome) => {
          settlements.push(outcome.status)
          return outcome.status !== 'pending'
        }
      return 'credential'
    },
  }
  MethodChallenge.register(method, () => undefined)
  return MethodResponse.register(method, ({ response }) => response)
}

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
  resource: { url: 'https://example.com/api' },
  x402Version: 2,
} satisfies PaymentRequired

const x402Eip3009Accept = {
  ...x402PaymentRequired.accepts[0]!,
  extra: {
    assetTransferMethod: 'eip3009',
    name: 'USDC',
    version: '2',
  },
} satisfies x402_Types.PaymentRequirements

/** Builds a valid 402 response with a WWW-Authenticate header. */
function make402(overrides?: { expires?: string; id?: string; intent?: string; method?: string }) {
  const id = overrides?.id ?? 'abc'
  const method = overrides?.method ?? 'test'
  const intent = overrides?.intent ?? 'test'
  const expires = overrides?.expires ? `, expires="${overrides.expires}"` : ''
  const request = btoa(JSON.stringify({ amount: '1' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const header = `Payment id="${id}", realm="test", method="${method}", intent="${intent}", request="${request}"${expires}`
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': header },
  })
}

function makeCombined402(overrides?: {
  expires?: string
  id?: string
  intent?: string
  method?: string
}) {
  const response = make402(overrides)
  const headers = new Headers(response.headers)
  headers.set(
    x402_Types.paymentRequiredHeader,
    x402_Header.encodePaymentRequired(x402PaymentRequired),
  )
  return new Response(null, {
    status: 402,
    headers,
  })
}

// Strict x402 encoding rejects unsupported accepts before the transport can filter them.
function encodeRawPaymentRequiredHeader(value: unknown): string {
  return Base64.fromString(JSON.stringify(value))
}

describe('Fetch.from: method responses', () => {
  test('handles successful paid responses without touching free responses', async () => {
    const method = { ...noopMethod }
    const handle = vi.fn(
      async ({ response }: MethodResponse.HandlerParameters) =>
        new Response(`handled:${await response.text()}`, response),
    )
    MethodResponse.register(method, handle)

    let paidResponse: Response | undefined
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      if (input.toString().endsWith('/free')) return new Response('free')
      if (!new Headers(init?.headers).has('Authorization')) return make402()
      paidResponse = new Response('paid')
      vi.spyOn(paidResponse, 'clone')
      return paidResponse
    }
    const fetch = Fetch.from({ fetch: mockFetch, methods: [method] })

    expect(await (await fetch('https://example.com/free')).text()).toBe('free')
    expect(handle).not.toHaveBeenCalled()
    expect(await (await fetch('https://example.com/paid')).text()).toBe('handled:paid')
    expect(handle).toHaveBeenCalledOnce()
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ credential: 'credential' }))
    expect(paidResponse?.clone).not.toHaveBeenCalled()
  })

  test.each([
    ['a rejected paid response', () => new Response('rejected', { status: 500 }), 500, undefined],
    ['the final payment retry', () => make402(), 402, 1],
    [
      'the paid request throwing',
      () => Promise.reject(new Error('paid request failed')),
      undefined,
      undefined,
    ],
  ])('settles credential state after %s', async (_name, paidRequest, status, maxPaymentRetries) => {
    const settlements: MethodResponse.AttemptOutcome['status'][] = []
    let calls = 0
    const fetch = Fetch.from({
      fetch: async () => (++calls === 1 ? make402() : paidRequest()),
      maxPaymentRetries,
      methods: [trackedMethod(settlements)],
    })

    const result = fetch('https://example.com/paid')
    if (status) expect((await result).status).toBe(status)
    else await expect(result).rejects.toThrow('paid request failed')
    expect(settlements).toEqual(['rejected'])
  })
})

describe('Fetch.from: init passthrough (non-402)', () => {
  test('preserves init object identity while adding Accept-Payment', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = {
      method: 'POST',
      headers: { 'X-Custom': 'value' },
      body: JSON.stringify({ data: 'test' }),
    }

    await fetch('https://example.com/ws-upgrade', customInit)

    expect(receivedInits[0]).toBe(customInit)
    const headers = new Headers(receivedInits[0]?.headers)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
  })

  test('preserves extra properties on init for non-402 responses', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = {
      method: 'GET',
      headers: { Authorization: 'Bearer token123' },
      signal: AbortSignal.timeout(5000),
    }

    await fetch('https://example.com/api', customInit)

    const received = receivedInits[0]!
    expect(received.method).toBe('GET')
    expect(new Headers(received.headers).get('Authorization')).toBe('Bearer token123')
    expect(new Headers(received.headers).get('Accept-Payment')).toBe('test/test')
    expect(received.signal).toBe(customInit.signal)
  })

  test('inherits request signals when init.signal is undefined', () => {
    const request = new Request('https://example.com/api', {
      signal: new AbortController().signal,
    })

    expect(
      Fetch.resolveRequestSignal(request, { signal: undefined } as unknown as RequestInit),
    ).toBe(request.signal)
    expect(Fetch.resolveRequestSignal(request, { signal: null })).toBeUndefined()
  })

  test('passes through undefined init', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('passes init with context through untouched', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const customInit = { method: 'POST', context: { account: '0xabc' } }
    await fetch('https://example.com/api', customInit as any)

    expect(receivedInits[0]).toBe(customInit)
    expect((receivedInits[0] as Record<string, unknown>).context).toEqual({ account: '0xabc' })
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('preserves Request-carried headers when injecting Accept-Payment', async () => {
    const receivedInputs: (RequestInfo | URL)[] = []
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      receivedInputs.push(input)
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const request = new Request('https://example.com/api', {
      headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
    })

    await fetch(request)

    expect(receivedInputs[0]).toBe(request)
    const headers = new Headers(receivedInits[0]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer token123')
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
  })

  test('does not overwrite an explicit Accept-Payment header', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'custom/charge;q=0.5' },
    })

    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('custom/charge;q=0.5')
  })

  test('uses an explicit Accept-Payment header to reprioritize challenge selection', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'stripe/charge, tempo/charge;q=0.1',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('stripe-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'stripe/charge, tempo/charge;q=0.1' },
    })
    expect(response.status).toBe(200)
  })

  test('applies an explicit method opt-out before broader wildcard preferences', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('stripe-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5' },
    })
    expect(response.status).toBe(200)
  })

  test('preserves non-header init fields across all non-402 status codes', async () => {
    for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 500, 503]) {
      const receivedInits: (RequestInit | undefined)[] = []
      const mockFetch: typeof globalThis.fetch = async (_input, init) => {
        receivedInits.push(init)
        return new Response(null, { status })
      }

      const fetch = Fetch.from({
        fetch: mockFetch,
        methods: [noopMethod],
      })

      const customInit = { method: 'GET' }
      await fetch('https://example.com/api', customInit)
      expect(receivedInits[0]?.method).toBe(customInit.method)
      expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
    }
  })
})

describe('Fetch.from: 402 retry path', () => {
  test('rejects expired challenges before hooks or credential creation', async () => {
    const createCredential = vi.fn(async () => 'credential')
    const onChallenge = vi.fn(async () => undefined)
    const mockFetch = vi.fn(async () =>
      make402({ expires: new Date(Date.now() - 60_000).toISOString() }),
    )
    const fetch = Fetch.from({
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [{ ...noopMethod, createCredential }],
      onChallenge,
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(Errors.PaymentExpiredError)
    expect(onChallenge).not.toHaveBeenCalled()
    expect(createCredential).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('strips context from init on retry', async () => {
    const calls: { init: RequestInit | undefined }[] = []
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      method: 'POST',
      context: { account: '0xabc' },
    } as any)

    expect(calls).toHaveLength(2)
    const retryInit = calls[1]!.init as Record<string, unknown>
    expect(retryInit).not.toHaveProperty('context')
  })

  test('adds Authorization header on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')

    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = new Headers(retryInit.headers as HeadersInit)
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('chooses native Payment-auth from combined MPP and x402 HTTP 402 offers', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return makeCombined402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    const retryHeaders = new Headers(calls[1]!.init?.headers)
    expect(retryHeaders.get('Authorization')).toBe('credential')
    expect(retryHeaders.get(x402_Types.paymentSignatureHeader)).toBeNull()
  })

  test('prefers mpp Payment-auth over x402 when both are signable', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return makeCombined402({ method: 'tempo', intent: 'charge' })
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'evm',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'evm-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    const retryHeaders = new Headers(calls[1]!.init?.headers)
    expect(retryHeaders.get('Authorization')).toBe('tempo-credential')
    expect(retryHeaders.get(x402_Types.paymentSignatureHeader)).toBeNull()
  })

  test('prefers native EVM Payment-auth over x402 for EVM-only clients', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return makeCombined402({ method: 'evm', intent: 'charge' })
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'evm',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'evm-credential',
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    const retryHeaders = new Headers(calls[1]!.init?.headers)
    expect(retryHeaders.get('Authorization')).toBe('evm-credential')
    expect(retryHeaders.get(x402_Types.paymentSignatureHeader)).toBeNull()
  })

  test.each([
    'https://example.com/api',
    'https://example.com/api?summary=hello',
    'https://other.example.com/different-path',
  ])('signs a standard x402 EIP-3009 challenge for %s without mppx extensions', async (url) => {
    const paymentRequired = {
      ...x402PaymentRequired,
      accepts: [x402Eip3009Accept],
    } satisfies PaymentRequired
    let callCount = 0
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      callCount++
      if (callCount === 1) {
        const response = new Response(null, {
          status: 402,
          headers: {
            [x402_Types.paymentRequiredHeader]: x402_Header.encodePaymentRequired(paymentRequired),
          },
        })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        evm.charge({
          account: accounts[0],
          currencies: [evm.assets.baseSepolia.USDC],
          maxAmount: '0.01',
          networks: [84532],
        }),
      ],
    })

    const response = await fetch(url)

    expect(response.status).toBe(200)
    expect(calls.map(({ input }) => input)).toEqual([url, url])
    const retryHeaders = new Headers(calls[1]!.init?.headers)
    expect(retryHeaders.get('Authorization')).toBeNull()
    const paymentSignature = retryHeaders.get(x402_Types.paymentSignatureHeader)
    expect(paymentSignature).toBeTruthy()
    const payload = x402_Header.decodePaymentSignature(paymentSignature!)
    expect(payload.accepted).toEqual(x402Eip3009Accept)
    expect(payload.extensions).toBeUndefined()
    expect(payload.resource).toEqual(paymentRequired.resource)
    if (!('authorization' in payload.payload)) throw new Error()
    expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('skips unsupported and policy-rejected x402 offers before signing a later offer', async () => {
    const paymentRequired = {
      ...x402PaymentRequired,
      accepts: [
        {
          ...x402Eip3009Accept,
          extra: { ...x402Eip3009Accept.extra, assetTransferMethod: 'permit2' },
        },
        { ...x402Eip3009Accept, network: 'eip155:8453' },
        { ...x402Eip3009Accept, amount: '10001' },
        { ...x402Eip3009Accept, extra: { assetTransferMethod: 'eip3009' } },
        x402Eip3009Accept,
      ],
    } satisfies PaymentRequired
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1)
        return new Response(null, {
          status: 402,
          headers: {
            [x402_Types.paymentRequiredHeader]: x402_Header.encodePaymentRequired(paymentRequired),
          },
        })
      return new Response('OK', { status: 200 })
    }
    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        evm.charge({
          account: accounts[0],
          currencies: [evm.assets.baseSepolia.USDC],
          maxAmount: '0.01',
          networks: [84532],
        }),
      ],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    const paymentSignature = new Headers(calls[1]!.init?.headers).get(
      x402_Types.paymentSignatureHeader,
    )
    expect(paymentSignature).toBeTruthy()
    expect(x402_Header.decodePaymentSignature(paymentSignature!).accepted).toEqual(
      x402Eip3009Accept,
    )
  })

  test('does not sign or retry when every x402 offer is unsupported or rejected by policy', async () => {
    const signTypedData = vi.fn(async () => '0x1234' as const)
    const paymentRequired = {
      ...x402PaymentRequired,
      accepts: [
        {
          ...x402Eip3009Accept,
          extra: { ...x402Eip3009Accept.extra, assetTransferMethod: 'permit2' },
        },
        { ...x402Eip3009Accept, network: 'eip155:8453' },
        { ...x402Eip3009Accept, amount: '10001' },
        { ...x402Eip3009Accept, extra: { assetTransferMethod: 'eip3009' } },
      ],
    } satisfies PaymentRequired
    const mockFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 402,
          headers: {
            [x402_Types.paymentRequiredHeader]: x402_Header.encodePaymentRequired(paymentRequired),
          },
        }),
    )
    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        evm.charge({
          account: { ...accounts[0], signTypedData } as unknown as Account,
          currencies: [evm.assets.baseSepolia.USDC],
          maxAmount: '0.01',
          networks: [84532],
        }),
      ],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow('No method found for challenges')
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(signTypedData).not.toHaveBeenCalled()
  })

  test('lets orderChallenges force x402 before native Payment-auth', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return makeCombined402({ method: 'evm', intent: 'charge' })
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'evm',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'x402-credential',
        },
      ] as const,
      orderChallenges: (candidates) =>
        [...candidates].sort((left, right) => right.challenge.id.localeCompare(left.challenge.id)),
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    const retryHeaders = new Headers(calls[1]!.init?.headers)
    expect(retryHeaders.get('Authorization')).toBeNull()
    expect(retryHeaders.get(x402_Types.paymentSignatureHeader)).toBe('x402-credential')
  })

  test('settles MCP-over-HTTP JSON-RPC payment challenges at the fetch boundary', async () => {
    const mcpChallenge = Challenge.from({
      id: 'mcp-challenge',
      intent: 'test',
      method: 'test',
      realm: 'test',
      request: { amount: '1' },
    })
    const method = {
      ...noopMethod,
      createCredential: async ({ challenge }: { challenge: Challenge.Challenge }) =>
        Credential.serialize({ challenge, payload: { source: 'mcp' } }),
    }
    const initialBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'paid-tool' },
    })
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1)
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: Mcp.paymentRequiredCode,
            message: 'Payment Required',
            data: { challenges: [mcpChallenge] },
          },
        })

      const body = JSON.parse(init?.body as string)
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      expect(body.params['_meta'][Mcp.credentialMetaKey]).toMatchObject({
        payload: { source: 'mcp' },
      })
      return Response.json({ ok: true })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      body: initialBody,
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test('settles MCP-over-HTTP result metadata payment challenges at the fetch boundary', async () => {
    const mcpChallenge = Challenge.from({
      id: 'mcp-result-challenge',
      intent: 'test',
      method: 'test',
      realm: 'test',
      request: { amount: '1' },
    })
    const method = {
      ...noopMethod,
      createCredential: async ({ challenge }: { challenge: Challenge.Challenge }) =>
        Credential.serialize({ challenge, payload: { source: 'mcp-result' } }),
    }
    const initialBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'paid-tool' },
    })
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1)
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'Payment Required' }],
            isError: true,
            _meta: {
              [Mcp.paymentRequiredMetaKey]: {
                httpStatus: 402,
                challenges: [mcpChallenge],
              },
            },
          },
        })

      const body = JSON.parse(init?.body as string)
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      expect(body.params['_meta'][Mcp.credentialMetaKey]).toMatchObject({
        payload: { source: 'mcp-result' },
      })
      return Response.json({ ok: true })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      body: initialBody,
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test('settles MCP-over-HTTP when the JSON-RPC request body is carried by Request input', async () => {
    const mcpChallenge = Challenge.from({
      id: 'mcp-request-input-challenge',
      intent: 'test',
      method: 'test',
      realm: 'test',
      request: { amount: '1' },
    })
    const method = {
      ...noopMethod,
      createCredential: async ({ challenge }: { challenge: Challenge.Challenge }) =>
        Credential.serialize({ challenge, payload: { source: 'request-input' } }),
    }
    const initialBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'paid-tool' },
    })
    let callCount = 0
    const calls: { init: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      callCount++
      if (callCount === 1) {
        expect(input).toBeInstanceOf(Request)
        expect(await (input as Request).text()).toBe(initialBody)
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: Mcp.paymentRequiredCode,
            message: 'Payment Required',
            data: { challenges: [mcpChallenge] },
          },
        })
      }

      const body = JSON.parse(init?.body as string)
      expect(body.params['_meta'][Mcp.credentialMetaKey]).toMatchObject({
        payload: { source: 'request-input' },
      })
      return Response.json({ ok: true })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [method],
    })
    const request = new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      body: initialBody,
    })

    const response = await fetch(request)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.input).toBe(request)
  })

  test('settles native HTTP 402 when a POST body is carried by Request input', async () => {
    const initialBody = JSON.stringify({ ok: true })
    let callCount = 0
    const calls: { init: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      callCount++
      const request = input instanceof Request && !init ? input : new Request(input, init)
      expect(await request.text()).toBe(initialBody)
      if (callCount === 1) return make402()

      expect(request.headers.get('Authorization')).toBe('credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })
    const request = new Request('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initialBody,
    })

    const response = await fetch(request)

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.input).toBe(request)
  })

  test('sends credential retry to the final same-origin 402 response URL', async () => {
    let callCount = 0
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      callCount++
      if (callCount === 1) {
        const response = make402()
        Object.defineProperty(response, 'url', {
          value: 'https://api.example.com/redirected-protected',
        })
        return response
      }
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const response = await fetch('https://api.example.com/protected')

    expect(response.status).toBe(200)
    expect(calls[0]!.input).toBe('https://api.example.com/protected')
    expect(calls[1]!.input).toBe('https://api.example.com/redirected-protected')
    expect(new Headers(calls[1]!.init?.headers).get('Authorization')).toBe('credential')
  })

  test('rejects credential retry to a cross-origin 402 response URL', async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input, init })
      const response = make402()
      Object.defineProperty(response, 'url', {
        value: 'https://payments.example.com/protected',
      })
      return response
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await expect(fetch('https://api.example.com/protected')).rejects.toThrow(
      'Refusing to send payment credential across redirect from https://api.example.com to https://payments.example.com',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe('https://api.example.com/protected')
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBeNull()
  })

  test('emits client events and allows challenge handler to provide credential', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const method = { ...noopMethod, createCredential }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      events.push(`*:${event.name}`)
    })
    eventDispatcher.on('challenge.received', async (payload) => {
      events.push(`challenge:${payload.challenge.id}`)
      return 'event-credential'
    })
    eventDispatcher.on('credential.created', (payload) => {
      events.push(`credential:${payload.credential}`)
      throw new Error('observer failed')
    })
    eventDispatcher.on('payment.response', (payload) => {
      events.push(`response:${payload.response.status}`)
      throw new Error('observer failed')
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('event-credential')
    expect(events).toEqual([
      'challenge:abc',
      '*:challenge.received',
      'credential:event-credential',
      '*:credential.created',
      'response:200',
      '*:payment.response',
    ])
  })

  test('uses the first challenge event credential', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('challenge.received', () => {
      events.push('first')
      return 'first-credential'
    })
    eventDispatcher.on('challenge.received', () => {
      events.push('second')
      return 'second-credential'
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('first-credential')
    expect(events).toEqual(['first'])
  })

  test('does not emit payment.response for non-ok retry responses', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('Internal Server Error', { status: 500 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('payment.response', (payload) => {
      events.push(`response:${payload.response.status}`)
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(500)
    expect(events).toEqual([])
  })

  test.each([
    [200, ['payment.response']],
    [201, ['payment.response']],
    [400, []],
    [403, []],
    [404, []],
    [500, ['payment.failed']],
    [502, ['payment.failed']],
    [503, ['payment.failed']],
  ])('reports a %i paid retry as %j without retrying', async (status, expected) => {
    const method = MethodResponse.registerTransactionHash(
      { ...noopMethod },
      (credential) => `hash:${credential}`,
    )
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).has('Authorization') ? new Response(null, { status }) : make402(),
    )
    const events: string[] = []
    const failures: Fetch.PaymentFailedPayload<[typeof method]>[] = []
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      if (event.name.startsWith('payment.')) events.push(event.name)
    })
    eventDispatcher.on('payment.failed', (payload) => {
      failures.push(payload)
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [method],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(status)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(events).toEqual(expected)
    for (const failure of failures) {
      expect(failure.error).toBeInstanceOf(Errors.PaymentOutcomeUnknownError)
      expect(failure.error).toMatchObject({
        challenge: { id: 'abc' },
        credential: 'credential',
        transactionHash: 'hash:credential',
      })
      expect(failure.response?.status).toBe(status)
    }
  })

  test('does not report a 403 credential replay as an unknown outcome', async () => {
    const replayed = new Errors.CredentialReplayedError()
    const events: string[] = []
    const eventDispatcher = Fetch.createEventDispatcher()
    eventDispatcher.on('*', (event) => {
      events.push(event.name)
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: async (_input, init) =>
        new Headers(init?.headers).has('Authorization')
          ? Response.json(replayed.toProblemDetails(), { status: replayed.status })
          : make402(),
      methods: [noopMethod],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(403)
    expect(response.headers.has('WWW-Authenticate')).toBe(false)
    expect(await response.json()).toMatchObject({ status: 403 })
    expect(events).toEqual(['challenge.received', 'credential.created'])
  })

  test.each([
    ['is not registered', (method: object) => method],
    [
      'throws',
      (method: object) =>
        MethodResponse.registerTransactionHash(method as never, () => {
          throw new Error('malformed')
        }),
    ],
  ])('reports a 5xx paid retry when hash derivation %s', async (_name, register) => {
    const method = register({ ...noopMethod }) as typeof noopMethod
    let calls = 0
    const failures: unknown[] = []
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('payment.failed', (payload) => {
      failures.push(payload.error)
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: async () => (++calls === 1 ? make402() : new Response(null, { status: 500 })),
      methods: [method],
    })

    expect((await fetch('https://example.com/api')).status).toBe(500)
    expect(failures).toEqual([expect.any(Errors.PaymentOutcomeUnknownError)])
    expect(failures[0]).toMatchObject({ credential: 'credential', transactionHash: undefined })
  })

  test.each([
    ['a network error', new TypeError('fetch failed')],
    ['an abort', new DOMException('The operation was aborted.', 'AbortError')],
  ])('reports %s on the paid retry and rethrows it', async (_name, cause) => {
    const method = MethodResponse.registerTransactionHash(
      { ...noopMethod },
      (credential) => `hash:${credential}`,
    )
    let calls = 0
    const failures: unknown[] = []
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('payment.failed', (payload) => {
      failures.push(payload.error)
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: async () => {
        if (++calls === 1) return make402()
        throw cause
      },
      methods: [method],
    })

    await expect(fetch('https://example.com/api')).rejects.toBe(cause)
    expect(calls).toBe(2)
    expect(failures).toEqual([expect.any(Errors.PaymentOutcomeUnknownError)])
    expect(failures[0]).toMatchObject({
      cause,
      challenge: { id: 'abc' },
      credential: 'credential',
      transactionHash: 'hash:credential',
    })
  })

  test.each([
    ['a complete body', ['settle failed'], true, 'settle failed', false],
    ['a large body', ['x'.repeat(40_000), 'x'.repeat(40_000)], false, 'x'.repeat(64 * 1024), true],
    ['a slow body', ['partial'], false, 'partial', true],
  ])(
    'buffers %s within bounds before payment.failed observers',
    async (_name, chunks, complete, expected, truncated) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        let cancelled = false
        const failures: Fetch.PaymentFailedPayload[] = []
        const eventDispatcher = Fetch.createEventDispatcher()
        eventDispatcher.on('payment.failed', (payload) => {
          failures.push(payload)
        })
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
            if (complete) controller.close()
          },
          cancel() {
            cancelled = true
          },
        })
        const fetch = Fetch.from({
          eventDispatcher,
          fetch: async (_input, init) =>
            new Headers(init?.headers).has('Authorization')
              ? new Response(body, { headers: { 'Content-Length': '100000' }, status: 500 })
              : make402(),
          methods: [noopMethod],
        })

        const result = fetch('https://example.com/api')
        await vi.advanceTimersByTimeAsync(2_000)
        const response = await result

        expect(await response.text()).toBe(expected)
        expect(response.headers.get('Mppx-Body-Truncated')).toBe(truncated ? 'true' : null)
        expect(response.headers.has('Content-Length')).toBe(!truncated)
        expect(cancelled).toBe(!complete)
        expect(failures).toHaveLength(1)
        expect(await failures[0]!.response?.text()).toBe(expected)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  test.each([
    ['fully buffered', 'settle failed', false],
    ['truncated', 'x'.repeat(100_000), true],
  ])('keeps the observable fields of a %s 5xx response', async (_name, body, truncated) => {
    const httpServer = await Http.createServer((req, res) => {
      if (!req.headers.authorization) {
        res.writeHead(402, { 'WWW-Authenticate': make402().headers.get('WWW-Authenticate')! })
        res.end()
        return
      }
      res.writeHead(500, 'Settlement Failed', {
        'Content-Type': 'text/plain',
        'X-Request-Id': 'abc',
      })
      res.end(body)
    })
    try {
      let original: Response | undefined
      const eventDispatcher = Fetch.createEventDispatcher()
      eventDispatcher.on('payment.failed', () => {})
      const fetch = Fetch.from({
        eventDispatcher,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init)
          if (new Headers(init?.headers).has('Authorization')) original = response
          return response
        },
        methods: [noopMethod],
      })

      const response = await fetch(`${httpServer.url}/paid`)

      expect(original).toBeDefined()
      expect(response === original).toBe(!truncated)
      expect({
        redirected: response.redirected,
        status: response.status,
        statusText: response.statusText,
        type: response.type,
        url: response.url,
      }).toEqual({
        redirected: original!.redirected,
        status: original!.status,
        statusText: original!.statusText,
        type: original!.type,
        url: original!.url,
      })
      const expectedHeaders = new Headers(original!.headers)
      if (truncated) {
        expectedHeaders.delete('content-length')
        expectedHeaders.set('Mppx-Body-Truncated', 'true')
      }
      expect(Object.fromEntries(response.headers)).toEqual(Object.fromEntries(expectedHeaders))
      expect(await response.text()).toBe(truncated ? body.slice(0, 64 * 1024) : body)
    } finally {
      httpServer.close()
    }
  })

  test('reports a 5xx body read failure and rethrows it', async () => {
    const cause = new TypeError('terminated')
    const failures: unknown[] = []
    const eventDispatcher = Fetch.createEventDispatcher()
    eventDispatcher.on('payment.failed', (payload) => {
      failures.push(payload.error)
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cause)
      },
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: async (_input, init) =>
        new Headers(init?.headers).has('Authorization')
          ? new Response(body, { status: 500 })
          : make402(),
      methods: [noopMethod],
    })

    await expect(fetch('https://example.com/api')).rejects.toBe(cause)
    expect(failures).toEqual([expect.any(Errors.PaymentOutcomeUnknownError)])
    expect(failures[0]).toMatchObject({ cause, credential: 'credential' })
  })

  test('releases a held 5xx connection before observers reconcile through it', async () => {
    // One-connection pool: a response holds the connection until its body is cancelled.
    let held = false
    const waiters: (() => void)[] = []
    const release = () => {
      held = false
      waiters.shift()?.()
    }
    const pooledFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      while (held) await new Promise<void>((resolve) => waiters.push(resolve))
      held = true
      if (input.toString().endsWith('/reconcile')) {
        release()
        return new Response('reconciled')
      }
      if (!new Headers(init?.headers).has('Authorization')) {
        release()
        return make402()
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(100_000))
          },
          cancel: release,
        }),
        { status: 500 },
      )
    }
    const reconciled: string[] = []
    const eventDispatcher = Fetch.createEventDispatcher()
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: pooledFetch as typeof globalThis.fetch,
      methods: [noopMethod],
    })
    eventDispatcher.on('payment.failed', async () => {
      reconciled.push(await (await fetch('https://example.com/reconcile')).text())
    })

    const response = await fetch('https://example.com/paid')

    expect(response.status).toBe(500)
    expect(response.headers.get('Mppx-Body-Truncated')).toBe('true')
    expect(reconciled).toEqual(['reconciled'])
  })

  test('ignores empty challenge event credentials and continues handlers', async () => {
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('challenge.received', () => '')
    eventDispatcher.on('challenge.received', () => 'second-credential')

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).not.toHaveBeenCalled()
    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('second-credential')
  })

  test('memoizes createCredential across wildcard observers and fallback', async () => {
    const createCredential = vi.fn(async () => 'method-credential')
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', async (event) => {
      if (event.name === 'challenge.received') await event.payload.createCredential()
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(createCredential).toHaveBeenCalledTimes(1)
  })

  test('does not expose live challenges or init headers to observers', async () => {
    const createCredential = vi.fn(async ({ challenge }) => `amount:${challenge.request.amount}`)
    const method = { ...noopMethod, createCredential }
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      if (event.name !== 'challenge.received') return
      try {
        ;(event.payload.challenge.request as { amount: string }).amount = '999'
      } catch {}
      const headers = new Headers(event.payload.init?.headers)
      headers.set('Authorization', 'attacker')
      if (event.payload.init) event.payload.init.headers = headers
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api', {
      headers: { 'X-Test': '1' },
    })

    const retryHeaders = new Headers((calls[1]!.init as RequestInit).headers)
    expect(retryHeaders.get('Authorization')).toBe('amount:1')
  })

  test('continues dispatching observer listeners after one throws', async () => {
    const events: string[] = []
    const method = { ...noopMethod, createCredential: vi.fn(async () => 'credential') }
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('credential.created', () => {
      events.push('first')
      throw new Error('observer failed')
    })
    eventDispatcher.on('credential.created', () => {
      events.push('second')
    })

    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch,
      methods: [method],
    })

    await fetch('https://example.com/api')

    expect(events).toEqual(['first', 'second'])
  })

  test('emits payment.failed when automatic payment handling rejects', async () => {
    const events: string[] = []
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch = vi.fn(async () =>
      make402({ expires: new Date(Date.now() - 60_000).toISOString() }),
    )
    const method = { ...noopMethod, createCredential }
    const eventDispatcher = Fetch.createEventDispatcher<[typeof method]>()
    eventDispatcher.on('*', (event) => {
      events.push(`*:${event.name}`)
    })
    eventDispatcher.on('payment.failed', (payload) => {
      events.push(
        `failed:${payload.error instanceof Errors.PaymentExpiredError}:${payload.challenge?.id}`,
      )
      throw new Error('observer failed')
    })
    const fetch = Fetch.from({
      eventDispatcher,
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [method],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(Errors.PaymentExpiredError)
    expect(createCredential).not.toHaveBeenCalled()
    expect(events).toEqual(['failed:true:abc', '*:payment.failed'])
  })

  test('retries a relative request whose 402 has no URL', async () => {
    const challenge = Challenge.from({
      id: 'relative',
      intent: 'charge',
      method: 'test',
      realm: 'api.example.com',
      request: { amount: '1' },
    })
    let calls = 0
    const fetch = Fetch.from({
      fetch: async () =>
        ++calls === 1
          ? new Response(null, {
              headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
              status: 402,
            })
          : new Response('ok'),
      methods: [
        Method.toClient(
          Method.from({
            intent: 'charge',
            name: 'test',
            schema: {
              credential: { payload: z.object({}) },
              request: z.object({ amount: z.string() }),
            },
          }),
          {
            createCredential: async ({ challenge }) =>
              Credential.serialize({ challenge, payload: {} }),
          },
        ),
      ],
    })

    expect(await (await fetch('/resource')).text()).toBe('ok')
  })

  test('preserves existing headers on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      headers: { 'X-Custom': 'value', 'Content-Type': 'application/json' },
    })

    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = new Headers(retryInit.headers as HeadersInit)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('preserves method and other init properties on retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api', {
      method: 'PUT',
      body: JSON.stringify({ data: 'test' }),
      credentials: 'include',
      mode: 'cors',
    })

    const retryInit = calls[1]!.init as Record<string, unknown>
    expect(retryInit.method).toBe('PUT')
    expect(retryInit.body).toBe(JSON.stringify({ data: 'test' }))
    expect(retryInit.credentials).toBe('include')
    expect(retryInit.mode).toBe('cors')
  })

  test('handles undefined init on 402 retry', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined }[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://example.com/api')

    expect(calls).toHaveLength(2)
    const retryInit = calls[1]!.init as Record<string, unknown>
    const headers = new Headers(retryInit.headers as HeadersInit)
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('preserves Request-carried headers on retry after injecting Accept-Payment', async () => {
    let callCount = 0
    const calls: { init: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({ init, input })
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const request = new Request('https://example.com/api', {
      headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
    })

    await fetch(request)

    expect(calls[0]?.input).toBe(request)
    expect(calls[1]?.input).toBe(request)
    const headers = new Headers(calls[1]?.init?.headers)
    expect(headers.get('X-Custom')).toBe('value')
    expect(headers.get('Accept-Payment')).toBe('test/test')
    expect(headers.get('Authorization')).toBe('credential')
  })

  test('selects the highest-ranked supported challenge', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe(
          'tempo/charge, stripe/charge;q=0.5',
        )

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('tempo-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
      acceptPayment: {
        definition: { 'stripe/charge': 0.5 },
        entries: [
          { intent: 'charge', method: 'tempo', q: 1, index: 0 },
          { intent: 'charge', method: 'stripe', q: 0.5, index: 1 },
        ],
        header: 'tempo/charge, stripe/charge;q=0.5',
        keys: {
          stripe: { charge: 'stripe/charge' },
          tempo: { charge: 'tempo/charge' },
        },
      },
    })

    const response = await fetch('https://example.com/api')
    expect(response.status).toBe(200)
  })

  test('ignores unsupported x402 accepts when selecting a Payment auth challenge', async () => {
    let callCount = 0
    const createCredential = vi.fn(async () => 'tempo-credential')
    const tempoChallenge = Challenge.from({
      id: 'tempo',
      realm: 'test',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1' },
    })
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            [x402_Types.paymentRequiredHeader]: encodeRawPaymentRequiredHeader({
              accepts: [
                {
                  amount: '10000',
                  asset: 'USDC',
                  maxTimeoutSeconds: 60,
                  network: 'solana:mainnet',
                  payTo: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWdYqPxfowV5n2kg',
                  scheme: 'exact',
                },
              ],
              resource: { url: 'https://example.com/api' },
              x402Version: 2,
            }),
            'WWW-Authenticate': Challenge.serialize(tempoChallenge),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('tempo-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential,
        },
      ] as const,
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential).toHaveBeenCalledOnce()
  })

  test('orderChallenges filters and sorts supported challenges before signing', async () => {
    let callCount = 0
    const pathUsd = Challenge.from({
      id: 'pathusd',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { chainId: 11155111, currency: 'pathusd' },
    })
    const usdc = Challenge.from({
      id: 'usdc',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { chainId: 8453, currency: 'usdc' },
    })
    const createCredential = vi.fn(
      async ({ challenge }: { challenge: Challenge.Challenge }) => `credential-${challenge.id}`,
    )

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': `${Challenge.serialize(pathUsd)}, ${Challenge.serialize(usdc)}`,
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('credential-usdc')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.request.currency === 'usdc'),
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(createCredential.mock.calls[0]?.[0].challenge.id).toBe('usdc')
  })

  test('request-local orderChallenges overrides configured ordering', async () => {
    let callCount = 0
    const first = Challenge.from({
      id: 'first',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { currency: 'first' },
    })
    const second = Challenge.from({
      id: 'second',
      realm: 'test',
      method: 'test',
      intent: 'test',
      request: { currency: 'second' },
    })
    const createCredential = vi.fn(
      async ({ challenge }: { challenge: Challenge.Challenge }) => `credential-${challenge.id}`,
    )

    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': `${Challenge.serialize(first)}, ${Challenge.serialize(second)}`,
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('credential-second')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.id === 'first'),
    })

    const response = await fetch('https://example.com/api', {
      orderChallenges: (candidates) =>
        candidates.filter(({ challenge }) => challenge.id === 'second'),
    })

    expect(response.status).toBe(200)
    expect(createCredential.mock.calls[0]?.[0].challenge.id).toBe('second')
  })

  test('throws when orderChallenges rejects every supported challenge', async () => {
    const mockFetch: typeof globalThis.fetch = async () => make402()
    const createCredential = vi.fn(async () => 'credential')

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
      orderChallenges: () => [],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(
      'No method found for challenges: test.test',
    )
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('falls back to configured preferences when explicit Accept-Payment is invalid', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBe('not a valid header')

        return new Response(null, {
          status: 402,
          headers: {
            'WWW-Authenticate': [
              'Payment id="stripe", realm="test", method="stripe", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
              'Payment id="tempo", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxIn0"',
            ].join(', '),
          },
        })
      }

      expect(new Headers(init?.headers).get('Authorization')).toBe('tempo-credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [
        {
          name: 'tempo',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'tempo-credential',
        },
        {
          name: 'stripe',
          intent: 'charge',
          context: undefined,
          createCredential: async () => 'stripe-credential',
        },
      ] as const,
      acceptPayment: {
        definition: { 'stripe/charge': 0.5 },
        entries: [
          { intent: 'charge', method: 'tempo', q: 1, index: 0 },
          { intent: 'charge', method: 'stripe', q: 0.5, index: 1 },
        ],
        header: 'tempo/charge, stripe/charge;q=0.5',
        keys: {
          stripe: { charge: 'stripe/charge' },
          tempo: { charge: 'tempo/charge' },
        },
      },
    })

    const response = await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'not a valid header' },
    })
    expect(response.status).toBe(200)
  })

  test('throws when no matching method for 402 challenge', async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      make402({ method: 'stripe', intent: 'charge' })

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await expect(fetch('https://example.com/api')).rejects.toThrow(
      'No method found for challenges: stripe.charge',
    )
  })

  test('creates a fresh credential for each incremental 402 challenge', async () => {
    const createCredential = vi.fn(
      async ({ challenge }: { challenge: Challenge.Challenge }) => `credential-${challenge.id}`,
    )
    const calls: { init: RequestInit | undefined }[] = []
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      calls.push({ init })
      callCount++
      if (callCount === 1) return make402({ id: 'first' })
      if (callCount === 2) return make402({ id: 'second' })
      if (callCount === 3) return make402({ id: 'third' })
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
    })

    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(200)
    expect(createCredential.mock.calls.map((call) => call[0].challenge.id)).toEqual([
      'first',
      'second',
      'third',
    ])
    expect(
      calls.slice(1).map((call) => new Headers(call.init?.headers).get('Authorization')),
    ).toEqual(['credential-first', 'credential-second', 'credential-third'])
  })

  test.each([
    {
      name: 'replayed credential',
      error: new Errors.CredentialReplayedError({
        reason: 'Transaction hash has already been used',
      }),
      status: 403,
      payments: 1,
    },
    {
      name: 'memo bound to another challenge',
      error: new Errors.CredentialReplayedError({ reason: 'memo is not bound to this challenge' }),
      status: 403,
      payments: 1,
    },
    {
      name: 'verification failure',
      error: new Errors.VerificationFailedError({ reason: 'amount mismatch' }),
      status: 402,
      payments: 3,
    },
  ])('does not pay again after a final $status ($name)', async ({ error, status, payments }) => {
    const createCredential = vi.fn(async () => 'credential')
    const transport = Transport_server.http()
    let requests = 0
    const mockFetch: typeof globalThis.fetch = async (input) => {
      requests++
      if (requests === 1) return make402({ id: 'first' })
      return transport.respondChallenge({
        challenge: Challenge.fromResponse(make402({ id: `retry-${requests}` })),
        error,
        input: new Request(input as string),
      })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
    })
    const response = await fetch('https://example.com/api')

    expect(response.status).toBe(status)
    expect(createCredential).toHaveBeenCalledTimes(payments)
  })

  test('invalidates a prepared credential across a generic challenge', async () => {
    const firstCredential = vi.fn(async () => 'first')
    const first = { ...noopMethod, name: 'first', createCredential: firstCredential }
    const second = { ...noopMethod, name: 'second', createCredential: async () => 'second' }
    MethodChallenge.register(first, () => undefined)
    const responses = [
      make402({ id: 'first', method: 'first' }),
      make402({ id: 'second', method: 'second' }),
      make402({ id: 'first', method: 'first' }),
      new Response('OK'),
    ]
    const mockFetch = vi.fn(async () => responses.shift()!)
    const fetch = Fetch.from({ fetch: mockFetch, methods: [first, second] })

    expect((await fetch('https://example.com/api')).status).toBe(200)
    expect(firstCredential).toHaveBeenCalledTimes(2)
  })

  test('invalidates a prepared credential after an explicit context', async () => {
    const createCredential = vi.fn(async () => 'credential')
    const method = { ...noopMethod, createCredential }
    MethodChallenge.register(method, () => undefined)
    let challenges = 0
    const mockFetch = vi.fn(async () => (++challenges <= 3 ? make402() : new Response('OK')))
    const fetch = Fetch.from({
      fetch: mockFetch as typeof globalThis.fetch,
      methods: [method],
      onChallenge: async (_challenge, { createCredential: create }) =>
        challenges === 2 ? create({ override: true } as never) : undefined,
    })

    expect((await fetch('https://example.com/api')).status).toBe(200)
    expect(createCredential).toHaveBeenCalledTimes(3)
  })

  test('caps repeated 402 retries at three', async () => {
    let callCount = 0
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      return make402()
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
    })

    const response = await fetch('https://example.com/api')
    expect(callCount).toBe(4)
    expect(createCredential).toHaveBeenCalledTimes(3)
    expect(response.status).toBe(402)
  })

  test('respects configured retry cap', async () => {
    let callCount = 0
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      return make402()
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      maxPaymentRetries: 1,
      methods: [{ ...noopMethod, createCredential }],
    })

    const response = await fetch('https://example.com/api')
    expect(callCount).toBe(2)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(response.status).toBe(402)
  })

  test('returns a challenge-less 402 after a rejected payment', async () => {
    let callCount = 0
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return new Response(JSON.stringify({ title: 'Verification Failed' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
    })

    const response = await fetch('https://example.com/api')
    expect(callCount).toBe(2)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(response.status).toBe(402)
    await expect(response.json()).resolves.toEqual({ title: 'Verification Failed' })
  })

  test('returns a post-payment 402 with only unsupported challenges', async () => {
    let callCount = 0
    const createCredential = vi.fn(async () => 'credential')
    const mockFetch: typeof globalThis.fetch = async () => {
      callCount++
      if (callCount === 1) return make402()
      return make402({ method: 'stripe', intent: 'charge' })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [{ ...noopMethod, createCredential }],
    })

    const response = await fetch('https://example.com/api')
    expect(callCount).toBe(2)
    expect(createCredential).toHaveBeenCalledOnce()
    expect(response.status).toBe(402)
  })
})

describe('Fetch.from: acceptPaymentPolicy', () => {
  test('policy: "always" injects Accept-Payment on all requests', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'always',
    })

    await fetch('https://cross-origin.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: "never" skips Accept-Payment on all requests', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: "same-origin" injects when no globalThis.location (server-side)', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'same-origin',
    })

    await fetch('https://example.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: { origins } injects only for matching origins', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['https://pay.example.com'] },
    })

    await fetch('https://pay.example.com/resource')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://other.example.com/resource')
    expect(new Headers(receivedInits[1]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: { origins } matches origin regardless of path', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['https://pay.example.com/some/path'] },
    })

    await fetch('https://pay.example.com/different/path')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })

  test('policy: { origins } supports wildcard subdomains', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: { origins: ['*.example.com'] },
    })

    await fetch('https://pay.example.com/resource')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://api.pay.example.com/resource')
    expect(new Headers(receivedInits[1]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://example.com/resource')
    expect(new Headers(receivedInits[2]?.headers).get('Accept-Payment')).toBe('test/test')

    await fetch('https://notexample.com/resource')
    expect(new Headers(receivedInits[3]?.headers).get('Accept-Payment')).toBeNull()
  })

  test('policy: "never" still handles 402 responses', async () => {
    let callCount = 0
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      callCount++
      if (callCount === 1) {
        expect(new Headers(init?.headers).get('Accept-Payment')).toBeNull()
        return make402()
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('credential')
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    const response = await fetch('https://example.com/api')
    expect(response.status).toBe(200)
  })

  test('policy: explicit Accept-Payment header always takes precedence over "never"', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
      acceptPaymentPolicy: 'never',
    })

    await fetch('https://example.com/api', {
      headers: { 'Accept-Payment': 'custom/charge' },
    })
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('custom/charge')
  })

  test('defaults to "always" for Fetch.from', async () => {
    const receivedInits: (RequestInit | undefined)[] = []
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      receivedInits.push(init)
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    await fetch('https://cross-origin.com/api')
    expect(new Headers(receivedInits[0]?.headers).get('Accept-Payment')).toBe('test/test')
  })
})

describe('Fetch.from: input passthrough', () => {
  test('passes URL input through on both initial and retry calls', async () => {
    let callCount = 0
    const receivedInputs: (RequestInfo | URL)[] = []
    const mockFetch: typeof globalThis.fetch = async (input, _init) => {
      receivedInputs.push(input)
      callCount++
      if (callCount === 1) return make402()
      return new Response('OK', { status: 200 })
    }

    const fetch = Fetch.from({
      fetch: mockFetch,
      methods: [noopMethod],
    })

    const url = new URL('https://example.com/resource')
    await fetch(url)

    expect(receivedInputs[0]).toBe(url)
    expect(receivedInputs[1]).toBe(url)
  })
})

describe('Fetch.polyfill', () => {
  test('default', async () => {
    Fetch.polyfill({
      methods: [
        tempo.charge({
          account: accounts[1],
          getClient: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect({
      ...receipt,
      reference: '[reference]',
      timestamp: '[timestamp]',
    }).toMatchInlineSnapshot(`
      {
        "fundingCurrency": "0x20c0000000000000000000000000000000000001",
        "method": "tempo",
        "reference": "[reference]",
        "status": "success",
        "timestamp": "[timestamp]",
      }
    `)

    httpServer.close()
    Fetch.restore()
  })
})

describe('Fetch.polyfill / restore', () => {
  test('restore is a no-op when polyfill was never called', () => {
    const before = globalThis.fetch
    Fetch.restore()
    expect(globalThis.fetch).toBe(before)
  })

  test('restore reverts to original fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    expect(globalThis.fetch).not.toBe(originalFetch)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('stacked polyfill calls preserve the true original fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    const firstPolyfill = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    expect(globalThis.fetch).not.toBe(firstPolyfill)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('double restore does not clobber fetch', () => {
    const originalFetch = globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)

    Fetch.restore()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test('restore is a no-op when fetch was replaced externally after polyfill', () => {
    const originalFetch = globalThis.fetch
    const externalFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('external', { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    Fetch.polyfill({ methods: [noopMethod] })
    globalThis.fetch = externalFetch

    Fetch.restore()
    expect(globalThis.fetch).toBe(externalFetch)

    globalThis.fetch = originalFetch
  })
})
