import { Store } from 'mppx'
import { Mppx as ClientMppx, evm as client_evm } from 'mppx/client'
import { evm, Mppx } from 'mppx/server'
import { Header as x402_Header, Siwx, Types as x402_Types } from 'mppx/x402'
import { createClient, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createSiweMessage } from 'viem/siwe'
import { describe, expect, test } from 'vp/test'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const other = privateKeyToAccount(`0x${'77'.repeat(32)}`)
const recipient = privateKeyToAccount(`0x${'42'.repeat(32)}`).address
const secretKey = 'test-secret-key-test-secret-key-32'
const origin = 'https://api.example.com'
const url = `${origin}/credits?task=1`

function createRoute(options: { granted?: readonly string[] } = {}) {
  const store = Store.memory()
  const settled: string[] = []
  const mppx = Mppx.create({
    methods: [
      evm({
        currency: evm.assets.baseSepolia.USDC,
        recipient,
        x402: {
          facilitator: {
            async verify() {
              return { isValid: true }
            },
            async settle(_payload, requirements) {
              settled.push('settle')
              return {
                network: requirements.network,
                success: true,
                transaction: `0x${'1'.repeat(64)}`,
              }
            },
          },
          siwx: {
            grant: ({ address }) => (options.granted ?? [account.address]).includes(address),
            origin,
            store,
          },
        },
      }),
    ],
    secretKey,
  })
  const route = mppx.evm.charge({ amount: '0.25' })
  async function handler(request: Request) {
    const result = await route(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json({ ok: true }))
  }
  return { handler, settled }
}

function readChallenge(response: Response) {
  return x402_Header.decodePaymentRequired(response.headers.get(x402_Types.paymentRequiredHeader)!)
}

async function sign(
  extension: Siwx.Extension,
  overrides: Partial<Omit<Siwx.Payload, 'signature'>> = {},
  signer = account,
) {
  const unsigned = {
    ...extension.info,
    address: signer.address,
    chainId: extension.supportedChains[0]!.chainId,
    type: 'eip191',
    ...overrides,
  }
  const signature = await signer.signMessage({ message: Siwx.toMessage(unsigned) })
  return Siwx.encode({ ...unsigned, signature })
}

async function challenge(handler: (request: Request) => Promise<Response>) {
  const response = await handler(new Request(url))
  expect(response.status).toBe(402)
  return Siwx.fromPaymentRequired(readChallenge(response))!
}

function withProof(proof: string) {
  return new Request(url, { headers: { [Siwx.header]: proof } })
}

describe('x402 sign-in-with-x', () => {
  test('the 402 offers the extension for the server origin and chain', async () => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const { expirationTime, issuedAt, nonce, ...info } = extension.info
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(Date.parse(expirationTime!) - Date.parse(issuedAt)).toBe(Siwx.ttl)
    expect({ info, supportedChains: extension.supportedChains }).toMatchInlineSnapshot(`
      {
        "info": {
          "domain": "api.example.com",
          "uri": "https://api.example.com/credits?task=1",
          "version": "1",
        },
        "supportedChains": [
          {
            "chainId": "eip155:84532",
            "type": "eip191",
          },
        ],
      }
    `)
  })

  test('a granted wallet gets the resource without paying', async () => {
    const { handler, settled } = createRoute()
    const extension = await challenge(handler)
    const response = await handler(withProof(await sign(extension)))
    expect(response.status).toBe(200)
    expect(settled).toEqual([])
    const receipt = JSON.parse(atob(response.headers.get('Payment-Receipt')!))
    expect(receipt.reference).toBe(`did:pkh:eip155:84532:${account.address}`)
  })

  test('a wallet grant refuses gets the 402 so it can pay', async () => {
    const { handler } = createRoute({ granted: [] })
    const extension = await challenge(handler)
    const response = await handler(withProof(await sign(extension)))
    expect(response.status).toBe(402)
    expect(readChallenge(response).error).not.toContain('siwx')
  })

  test('a proof is accepted once', async () => {
    const { handler } = createRoute()
    const proof = await sign(await challenge(handler))
    expect((await handler(withProof(proof))).status).toBe(200)
    const replay = await handler(withProof(proof))
    expect(replay.status).toBe(402)
    expect(readChallenge(replay).error).toContain('invalid_siwx_nonce')
  })

  test.each([
    ['another domain', { domain: 'evil.example' }, 'invalid_siwx_domain_mismatch'],
    ['another origin in uri', { uri: 'https://evil.example/credits' }, 'invalid_siwx_uri_mismatch'],
    ['another chain', { chainId: 'eip155:1' }, 'invalid_siwx_unsupported_chain'],
    [
      'an expired message',
      { expirationTime: new Date(Date.now() - 1000).toISOString() },
      'invalid_siwx_expired',
    ],
    [
      'an old message',
      { issuedAt: new Date(Date.now() - Siwx.ttl - 1000).toISOString() },
      'invalid_siwx_issued_at_too_old',
    ],
    [
      'a future message',
      { issuedAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      'invalid_siwx_issued_at_in_future',
    ],
    [
      'a not-yet-valid message',
      { notBefore: new Date(Date.now() + 60_000).toISOString() },
      'invalid_siwx_not_yet_valid',
    ],
  ] as const)('rejects %s', async (_name, overrides, code) => {
    const { handler, settled } = createRoute()
    const extension = await challenge(handler)
    const response = await handler(withProof(await sign(extension, overrides)))
    expect(response.status).toBe(402)
    expect(readChallenge(response).error).toContain(code)
    expect(settled).toEqual([])
  })

  test.each([
    [
      'a non-EVM chain',
      { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
      'invalid_siwx_unsupported_chain',
    ],
    ['a short nonce', { nonce: 'abc' }, 'invalid_siwx_nonce'],
    ['a statement with a newline', { statement: 'two\nlines' }, 'invalid_siwx_payload'],
  ] as const)('rejects %s before checking the signature', async (_name, overrides, code) => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const payload = {
      ...extension.info,
      address: account.address,
      chainId: extension.supportedChains[0]!.chainId,
      signature: '0x00',
      type: 'eip191',
      ...overrides,
    }
    const response = await handler(withProof(Siwx.encode(payload)))
    expect(readChallenge(response).error).toContain(code)
  })

  test('rejects a signature from another wallet', async () => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const unsigned = {
      ...extension.info,
      address: account.address,
      chainId: extension.supportedChains[0]!.chainId,
      type: 'eip191',
    }
    const signature = await other.signMessage({ message: Siwx.toMessage(unsigned) })
    const response = await handler(withProof(Siwx.encode({ ...unsigned, signature })))
    expect(readChallenge(response).error).toContain('invalid_siwx_signature')
  })

  test('a proof the grant declined is spent', async () => {
    const { handler } = createRoute({ granted: [] })
    const proof = await sign(await challenge(handler))
    expect((await handler(withProof(proof))).status).toBe(402)
    const replay = await handler(withProof(proof))
    expect(readChallenge(replay).error).toContain('invalid_siwx_nonce')
  })

  test('a rejected proof does not use up its nonce', async () => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const unsigned = {
      ...extension.info,
      address: account.address,
      chainId: extension.supportedChains[0]!.chainId,
      type: 'eip191',
    }
    const forged = await other.signMessage({ message: Siwx.toMessage(unsigned) })
    await handler(withProof(Siwx.encode({ ...unsigned, signature: forged })))
    expect((await handler(withProof(await sign(extension)))).status).toBe(200)
  })

  test('rejects a smart-wallet check through a client on another chain', async () => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const client = createClient({
      chain: base,
      transport: custom({
        async request() {
          throw new Error('no rpc call expected')
        },
      }),
    })
    await expect(
      Siwx.verify({
        chainId: 84532,
        options: { client, origin },
        payload: Siwx.decode(await sign(extension)),
      }),
    ).rejects.toMatchObject({ code: 'invalid_siwx_verifier_error' })
  })

  test("toMessage keeps viem's layout and signs timestamps as sent", () => {
    const base = {
      address: account.address,
      chainId: 'eip155:84532',
      domain: 'api.example.com',
      issuedAt: '2026-01-02T03:04:05.678Z',
      nonce: 'abcdef0123456789',
      type: 'eip191',
      uri: url,
      version: '1',
    }
    for (const payload of [
      base,
      {
        ...base,
        expirationTime: '2026-01-02T03:09:05.678Z',
        notBefore: '2026-01-02T03:04:00.000Z',
        requestId: 'req-1',
        resources: [url, `${origin}/other`],
        statement: 'Sign in to the API',
      },
    ])
      expect(Siwx.toMessage(payload)).toBe(
        createSiweMessage({
          address: payload.address,
          chainId: 84532,
          domain: payload.domain,
          issuedAt: new Date(payload.issuedAt),
          nonce: payload.nonce,
          uri: payload.uri,
          version: '1',
          ...('statement' in payload
            ? {
                expirationTime: new Date(payload.expirationTime),
                notBefore: new Date(payload.notBefore),
                requestId: payload.requestId,
                resources: payload.resources,
                statement: payload.statement,
              }
            : {}),
        }),
      )
    const offset = Siwx.toMessage({ ...base, issuedAt: '2026-01-02T04:04:05+01:00' })
    expect(offset).toContain('\nIssued At: 2026-01-02T04:04:05+01:00')
    expect(() => Siwx.toMessage({ ...base, issuedAt: '2026-01-02' })).toThrow()
  })

  test('accepts a proof whose timestamps are not in toISOString form', async () => {
    const { handler } = createRoute()
    const extension = await challenge(handler)
    const issuedAt = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, '+00:00')
    const response = await handler(withProof(await sign(extension, { issuedAt })))
    expect(response.status).toBe(200)
  })

  test('rejects a malformed header', async () => {
    const { handler } = createRoute()
    const response = await handler(withProof('not-base64-json'))
    expect(readChallenge(response).error).toContain('invalid_siwx_payload')
  })

  test('a route without siwx offers no extension', async () => {
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator: {
              verify: async () => ({ isValid: true }),
              settle: async () => ({ success: true, transaction: '0x', network: 'x' }),
            },
          },
        }),
      ],
      secretKey,
    })
    const result = await mppx.evm.charge({ amount: '0.25' })(new Request(url))
    if (result.status !== 402) throw new Error()
    expect(Siwx.fromPaymentRequired(readChallenge(result.challenge))).toBeUndefined()
  })
})

describe('Siwx.createExtension', () => {
  test('percent-encodes URL characters a SIWE URI cannot hold', async () => {
    const extension = Siwx.createExtension({
      chainId: 84532,
      origin,
      url: `${origin}/a|b{c}^d?q=\`x\`[1]`,
    })
    expect(extension.info.uri).toBe(`${origin}/a%7Cb%7Bc%7D%5Ed?q=%60x%60%5B1%5D`)
    // `sign` builds the SIWE message, which throws for a URI it can't hold.
    await expect(sign(extension)).resolves.toBeTypeOf('string')
  })

  test('percent-encodes a % that does not start a valid escape', async () => {
    const extension = Siwx.createExtension({
      chainId: 84532,
      origin,
      url: `${origin}/100%?a=%zz&b=%2F&c=%4`,
    })
    expect(extension.info.uri).toBe(`${origin}/100%25?a=%25zz&b=%2F&c=%254`)
    await expect(sign(extension)).resolves.toBeTypeOf('string')
  })
})

describe('Siwx grant', () => {
  test('a grant that reads the body leaves it for the route handler', async () => {
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator: {
              async verify() {
                return { isValid: true }
              },
              async settle() {
                throw new Error('not settled')
              },
            },
            siwx: {
              grant: async ({ request }) => (await request.text()) === '{"task":1}',
              origin,
              store: Store.memory(),
            },
          },
        }),
      ],
      secretKey,
    })
    const route = mppx.evm.charge({ amount: '0.25' })
    const post = (headers: HeadersInit = {}) =>
      new Request(url, { body: '{"task":1}', headers, method: 'POST' })
    const first = await route(post())
    if (first.status !== 402) throw new Error('expected a 402')
    const extension = Siwx.fromPaymentRequired(readChallenge(first.challenge))!
    const request = post({ [Siwx.header]: await sign(extension) })
    const result = await route(request)
    expect(result.status).toBe(200)
    expect(await request.text()).toBe('{"task":1}')
  })

  test('a grant that leaves the body unread releases its copy', async () => {
    const copies: Request[] = []
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator: {
              async verify() {
                return { isValid: true }
              },
              async settle() {
                throw new Error('not settled')
              },
            },
            siwx: {
              grant: ({ request }) => (copies.push(request), true),
              origin,
              store: Store.memory(),
            },
          },
        }),
      ],
      secretKey,
    })
    const route = mppx.evm.charge({ amount: '0.25' })
    const post = (headers: HeadersInit = {}) =>
      new Request(url, { body: '{"task":1}', headers, method: 'POST' })
    const first = await route(post())
    if (first.status !== 402) throw new Error('expected a 402')
    const extension = Siwx.fromPaymentRequired(readChallenge(first.challenge))!
    const request = post({ [Siwx.header]: await sign(extension) })
    const result = await route(request)
    expect(result.status).toBe(200)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.bodyUsed).toBe(true)
    expect(await request.text()).toBe('{"task":1}')
  })

  test('a request whose body was already read still grants, without the body', async () => {
    const store = Store.memory()
    const bodies: string[] = []
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator: {
              async verify() {
                return { isValid: true }
              },
              async settle() {
                throw new Error('not settled')
              },
            },
            siwx: {
              grant: async ({ request }) => {
                bodies.push(await request.text())
                return true
              },
              origin,
              store,
            },
          },
        }),
      ],
      secretKey,
    })
    const route = mppx.evm.charge({ amount: '0.25' })
    const post = (headers: HeadersInit = {}) =>
      new Request(url, { body: '{"task":1}', headers, method: 'POST' })
    const first = await route(post())
    if (first.status !== 402) throw new Error('expected a 402')
    const extension = Siwx.fromPaymentRequired(readChallenge(first.challenge))!
    const request = post({ [Siwx.header]: await sign(extension) })
    await request.text()
    const result = await route(request)
    expect(result.status).toBe(200)
    expect(bodies).toEqual([''])
  })
})

describe('Siwx.wrapFetch', () => {
  test('signs in once and skips payment for a granted wallet', async () => {
    const { handler, settled } = createRoute()
    const requests: Request[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return handler(request)
      },
      { account },
    )
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(requests.map((request) => request.headers.has(Siwx.header))).toEqual([false, true])
    expect(settled).toEqual([])
  })

  test('falls through to payment through mppx when the wallet is not granted', async () => {
    const { handler, settled } = createRoute({ granted: [] })
    const mppx = ClientMppx.create({
      fetch: Siwx.wrapFetch(async (input, init) => handler(new Request(input, init)), { account }),
      methods: [client_evm({ account, currencies: [client_evm.assets.baseSepolia.USDC] })],
      polyfill: false,
    })
    const response = await mppx.fetch(url)
    expect(response.status).toBe(200)
    expect(settled).toEqual(['settle'])
  })

  test('keeps symbol-keyed init controls on every call', async () => {
    const { handler } = createRoute()
    const control = Symbol.for('mppx.fetch.skipPayment')
    const seen: unknown[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        seen.push((init as Record<symbol, unknown> | undefined)?.[control])
        return handler(new Request(input, init))
      },
      { account },
    )
    const response = await fetch(url, { [control]: true } as RequestInit)
    expect(response.status).toBe(200)
    expect(seen).toEqual([true, true])
  })

  test('returns the 402 of a request that already carries a payment', async () => {
    const { handler } = createRoute()
    const requests: Request[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        requests.push(new Request(input, init))
        // The server refuses the payment with its SIWX-offering 402.
        return handler(new Request(url))
      },
      { account },
    )
    for (const headers of [
      { Authorization: 'Payment abc' },
      { [x402_Types.paymentSignatureHeader]: 'abc' },
      { [x402_Types.legacyPaymentSignatureHeader]: 'abc' },
    ]) {
      requests.length = 0
      const response = await fetch(url, { headers })
      expect(response.status).toBe(402)
      expect(requests).toHaveLength(1)
    }
  })

  test('resends a request body with the proof', async () => {
    const { handler } = createRoute()
    const bodies: string[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const request = new Request(input, init)
        bodies.push(await request.clone().text())
        return handler(request)
      },
      { account },
    )
    const response = await fetch(url, { body: '{"task":1}', method: 'POST' })
    expect(response.status).toBe(200)
    expect(bodies).toEqual(['{"task":1}', '{"task":1}'])
  })

  test('passes a streamed upload through without signing', async () => {
    const { handler } = createRoute()
    const requests: Request[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return handler(request)
      },
      { account },
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"task":1}'))
        controller.close()
      },
    })
    const response = await fetch(url, { body, duplex: 'half', method: 'POST' } as RequestInit)
    expect(response.status).toBe(402)
    expect(requests).toHaveLength(1)
  })

  test('returns the 402 for a challenge the SIWE format cannot encode', async () => {
    const { handler } = createRoute()
    let calls = 0
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        calls++
        const response = await handler(new Request(input, init))
        const required = readChallenge(response) as Record<string, any>
        required.extensions[Siwx.extensionKey].info.statement = 'line one\nline two'
        const headers = new Headers(response.headers)
        headers.set(
          x402_Types.paymentRequiredHeader,
          Buffer.from(JSON.stringify(required)).toString('base64'),
        )
        return new Response(null, { status: 402, headers })
      },
      { account },
    )
    const response = await fetch(url)
    expect(response.status).toBe(402)
    expect(calls).toBe(1)
  })

  test('does not sign a challenge naming another site', async () => {
    const { handler } = createRoute()
    let calls = 0
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        calls++
        const request = new Request(input, init)
        // The 402 comes from the real server, but the client asked another host.
        return handler(new Request(url, { headers: request.headers }))
      },
      { account },
    )
    const response = await fetch('https://other.example.com/credits?task=1')
    expect(response.status).toBe(402)
    expect(calls).toBe(1)
  })

  test('does not sign a challenge reached through a cross-origin redirect', async () => {
    const { handler } = createRoute()
    let calls = 0
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        calls++
        const response = await handler(
          new Request(url, { headers: new Request(input, init).headers }),
        )
        // As native fetch reports a response after following a redirect.
        Object.defineProperty(response, 'url', { value: url })
        return response
      },
      { account },
    )
    const response = await fetch('https://attacker.example/start')
    expect(response.status).toBe(402)
    expect(calls).toBe(1)
  })

  test('returns a 402 reached through a same-origin redirect', async () => {
    const { handler } = createRoute()
    const methods: string[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const request = new Request(input, init)
        methods.push(request.method)
        const response = await handler(new Request(url, { headers: request.headers }))
        // As native fetch reports a response after following a redirect.
        Object.defineProperty(response, 'redirected', { value: true })
        return response
      },
      { account },
    )
    const response = await fetch(url + '/old', { body: '{"task":1}', method: 'POST' })
    expect(response.status).toBe(402)
    expect(methods).toEqual(['POST'])
  })

  test('returns the 402 of a request that carries a single-use identity proof', async () => {
    const { handler } = createRoute()
    const requests: Request[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        requests.push(new Request(input, init))
        return handler(new Request(url))
      },
      { account },
    )
    for (const headers of [
      { Signature: 'sig1=:abc:', 'Signature-Input': 'sig1=("@authority");nonce="n"' },
      { DPoP: 'eyJ' },
    ]) {
      requests.length = 0
      const response = await fetch(url, { headers })
      expect(response.status).toBe(402)
      expect(requests).toHaveLength(1)
    }
  })

  test('does not follow redirects with the proof', async () => {
    const { handler } = createRoute()
    const redirects: RequestRedirect[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const request = new Request(input, init)
        redirects.push(request.redirect)
        return handler(request)
      },
      { account },
    )
    await fetch(url)
    expect(redirects).toEqual(['follow', 'manual'])
  })

  test('retries when the underlying fetch keeps a clone of the 402', async () => {
    const { handler } = createRoute()
    const kept: Response[] = []
    const fetch = Siwx.wrapFetch(
      async (input, init) => {
        const response = await handler(new Request(input, init))
        kept.push(response.clone())
        return response
      },
      { account },
    )
    const response = await fetch(url)
    expect(response.status).toBe(200)
  })
})

describe('x402 sign-in-with-x in composed routes', () => {
  test('keeps every payment offer and lists every chain', async () => {
    const store = Store.memory()
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ network: 'x', success: true, transaction: '0x' }),
    }
    const siwx = { grant: () => true, origin, store }
    const mppx = Mppx.create({
      methods: [
        evm({ currency: evm.assets.baseSepolia.USDC, recipient, x402: { facilitator, siwx } }),
        evm({ currency: evm.assets.base.USDC, recipient, x402: { facilitator, siwx } }),
      ],
      secretKey,
    })
    const result = await mppx.compose(
      [mppx.methods[0]!, { amount: '0.25' }],
      [mppx.methods[1]!, { amount: '0.25' }],
    )(new Request(url))
    if (result.status !== 402) throw new Error()
    const paymentRequired = readChallenge(result.challenge)
    expect(paymentRequired.error).not.toContain('Cannot merge')
    expect(paymentRequired.accepts.map((offer) => offer.network)).toEqual([
      'eip155:84532',
      'eip155:8453',
    ])
    expect(Siwx.fromPaymentRequired(paymentRequired)?.supportedChains).toEqual([
      { chainId: 'eip155:84532', type: 'eip191' },
      { chainId: 'eip155:8453', type: 'eip191' },
    ])
  })

  test('an offer that declines the wallet leaves the proof for one that grants it', async () => {
    const store = Store.memory()
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ network: 'x', success: true, transaction: '0x' }),
    }
    const grants: string[] = []
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator,
            siwx: { grant: () => (grants.push('decline'), false), origin, store },
          },
        }),
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient: account.address,
          x402: { facilitator, siwx: { grant: () => (grants.push('grant'), true), origin, store } },
        }),
      ],
      secretKey,
    })
    const route = mppx.compose(
      [mppx.methods[0]!, { amount: '0.25' }],
      [mppx.methods[1]!, { amount: '0.25' }],
    )
    const challenged = await route(new Request(url))
    if (challenged.status !== 402) throw new Error()
    const extension = Siwx.fromPaymentRequired(readChallenge(challenged.challenge))!
    const proof = await sign(extension)
    const result = await route(withProof(proof))
    expect(result.status).toBe(200)
    expect(grants).toEqual(['decline', 'grant'])
    // A replay is refused before any offer asks grant again.
    const replay = await route(withProof(proof))
    expect(replay.status).toBe(402)
    expect(grants).toEqual(['decline', 'grant'])
  })

  test('offers with separate stores each record the nonce', async () => {
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ network: 'x', success: true, transaction: '0x' }),
    }
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: { facilitator, siwx: { grant: () => false, origin, store: Store.memory() } },
        }),
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient: account.address,
          x402: { facilitator, siwx: { grant: () => true, origin, store: Store.memory() } },
        }),
      ],
      secretKey,
    })
    const route = mppx.compose(
      [mppx.methods[0]!, { amount: '0.25' }],
      [mppx.methods[1]!, { amount: '0.25' }],
    )
    const challenged = await route(new Request(url))
    if (challenged.status !== 402) throw new Error()
    const proof = await sign(Siwx.fromPaymentRequired(readChallenge(challenged.challenge))!)
    expect((await route(withProof(proof))).status).toBe(200)
    // The granting offer's own store refuses the replay.
    const single = mppx.compose([mppx.methods[1]!, { amount: '0.25' }])
    expect((await single(withProof(proof))).status).toBe(402)
  })

  test('a later offer with its own store refuses a proof an earlier offer found replayed', async () => {
    const facilitator = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ network: 'x', success: true, transaction: '0x' }),
    }
    const grants: string[] = []
    const mppx = Mppx.create({
      methods: [
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient,
          x402: {
            facilitator,
            siwx: { grant: () => (grants.push('first'), true), origin, store: Store.memory() },
          },
        }),
        evm({
          currency: evm.assets.baseSepolia.USDC,
          recipient: account.address,
          x402: {
            facilitator,
            siwx: { grant: () => (grants.push('second'), true), origin, store: Store.memory() },
          },
        }),
      ],
      secretKey,
    })
    const route = mppx.compose(
      [mppx.methods[0]!, { amount: '0.25' }],
      [mppx.methods[1]!, { amount: '0.25' }],
    )
    const challenged = await route(new Request(url))
    if (challenged.status !== 402) throw new Error()
    const proof = await sign(Siwx.fromPaymentRequired(readChallenge(challenged.challenge))!)
    expect((await route(withProof(proof))).status).toBe(200)
    expect(grants).toEqual(['first'])
    expect((await route(withProof(proof))).status).toBe(402)
    expect(grants).toEqual(['first'])
  })
})

describe('Siwx.release', () => {
  test('deletes the nonce while its claim holds', async () => {
    const store = Store.memory()
    const payload = { issuedAt: new Date().toISOString(), nonce: 'release-fresh-1' }
    await Siwx.claim({ payload, store })
    await Siwx.release({ payload, store })
    await expect(Siwx.claim({ payload, store })).resolves.toBeUndefined()
  })

  test('frees a claim the store keeps apart from its values', async () => {
    // Like a Durable Object replay shard: `tryClaim` records claims that `get` and
    // `update` don't see, and only `delete` releases.
    const values = Store.memory()
    const claims = new Map<string, number>()
    const store = Store.from({
      get: (key) => values.get(key as never),
      put: (key, value) => values.put(key as never, value as never),
      update: (key, fn) => values.update(key as never, fn as never),
      async delete(key) {
        claims.delete(key)
        await values.delete(key as never)
      },
      async tryClaim(key, expires) {
        if ((claims.get(key) ?? 0) > Date.now()) return false
        claims.set(key, expires)
        return true
      },
    }) as Store.AtomicStore
    const payload = { issuedAt: new Date().toISOString(), nonce: 'release-native-1' }
    await Siwx.claim({ payload, store })
    await Siwx.release({ payload, store })
    await expect(Siwx.claim({ payload, store })).resolves.toBeUndefined()
  })

  test('leaves a newer claim alone once its own claim expired', async () => {
    const store = Store.memory()
    const nonce = 'release-stale-1'
    const stale = { issuedAt: new Date(Date.now() - Siwx.ttl - 2 * 60_000).toISOString(), nonce }
    const fresh = { issuedAt: new Date().toISOString(), nonce }
    await Siwx.claim({ payload: fresh, store })
    await Siwx.release({ payload: stale, store })
    await expect(Siwx.claim({ payload: fresh, store })).rejects.toThrow('invalid_siwx_nonce')
  })
})
