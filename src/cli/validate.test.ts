import type * as http from 'node:http'

import { afterEach, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

import * as Challenge from '../Challenge.js'
import * as Constants from '../Constants.js'
import * as Receipt from '../Receipt.js'

// Keep CLI orchestration tests independent of the public Tempo RPC and faucet.
vi.doMock('viem/tempo', async () => {
  const actual = await vi.importActual<typeof import('viem/tempo')>('viem/tempo')
  return {
    ...actual,
    Actions: {
      ...actual.Actions,
      faucet: { ...actual.Actions.faucet, fund: vi.fn(async () => []) },
    },
  }
})

vi.doMock('viem/actions', async () => {
  const actual = await vi.importActual<typeof import('viem/actions')>('viem/actions')
  return {
    ...actual,
    prepareTransactionRequest: vi.fn(async () => ({})),
    signTransaction: vi.fn(async () => '0xdeadbeef'),
  }
})

// Auto-cleanup for test servers
const servers: Http.TestServer[] = []
afterEach(() => {
  servers.forEach((s) => s.close())
  servers.length = 0
})

async function testServer(handler: http.RequestListener) {
  const s = await Http.createServer(handler)
  servers.push(s)
  return s
}

async function serve(argv: string[]) {
  const { default: validate } = await import('./validate/index.js')
  let output = ''
  let exitCode: number | undefined
  const origLog = console.log
  const origStdout = process.stdout.write
  const origStderr = process.stderr.write
  console.log = (...args: unknown[]) => {
    output += `${args.map(String).join(' ')}\n`
  }
  process.stdout.write = ((chunk: unknown) => {
    output += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    output += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const { Cli } = await import('incur')
    const cli = Cli.create('mppx', {})
    cli.command(validate)
    await cli.serve(argv, {
      stdout(s: string) {
        output += s
      },
      exit(code: number) {
        exitCode = code
      },
    })
  } finally {
    console.log = origLog
    process.stdout.write = origStdout
    process.stderr.write = origStderr
  }
  return { output, exitCode }
}

function makeChallenge(overrides?: Partial<Challenge.Challenge>) {
  return {
    id: 'test-id-123',
    realm: 'localhost',
    method: 'tempo',
    intent: 'charge',
    request: {
      amount: '10000',
      currency: '0x20c0000000000000000000000000000000000000',
      recipient: '0x1234567890123456789012345678901234567890',
      methodDetails: { chainId: 42431 },
    },
    expires: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  } as Challenge.Challenge
}

function makeDiscoveryDoc(
  endpoints: Record<string, { method?: string; amount?: string; requestBody?: unknown }> = {},
) {
  const paths: Record<string, unknown> = {}
  for (const [path, opts] of Object.entries(endpoints)) {
    const op: Record<string, unknown> = {
      'x-payment-info': { method: 'tempo', intent: 'charge', amount: opts.amount ?? '10000' },
      responses: { '402': { description: 'Payment required' } },
    }
    if (opts.requestBody) op.requestBody = opts.requestBody
    paths[path] = { [opts.method?.toLowerCase() ?? 'post']: op }
  }
  return JSON.stringify({ openapi: '3.1.0', info: { title: 'Test', version: '1.0.0' }, paths })
}

async function mppServer(
  challenge: Challenge.Challenge,
  opts?: { errorStatus?: number; postPaymentStatus?: number },
) {
  return testServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/openapi.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(makeDiscoveryDoc({ '/api/test': {} }))
      return
    }
    const hasAuth = req.headers[Constants.Headers.authorization.toLowerCase()]
    if (hasAuth && hasAuth !== `${Constants.Schemes.payment} dGhpcyBpcyBnYXJiYWdl`) {
      const status = opts?.postPaymentStatus ?? 200
      const receipt = Receipt.serialize({
        method: 'tempo',
        status: 'success',
        reference: '0x' + 'ab'.repeat(32),
        timestamp: new Date().toISOString(),
      })
      res.writeHead(status, {
        [Constants.Headers.paymentReceipt]: receipt,
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ result: 'ok' }))
    } else if (hasAuth) {
      const errorStatus = opts?.errorStatus ?? 402
      if (errorStatus === 402) {
        res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
      } else {
        res.writeHead(errorStatus)
      }
      res.end()
    } else {
      res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
      res.end()
    }
  })
}

describe('validate: discovery', () => {
  test('succeeds with valid discovery doc', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Document found and parseable')
    expect(output).toContain('Valid OpenAPI structure')
    expect(output).toContain('Paid endpoints found')
  })

  test('reports missing discovery doc', { timeout: 15_000 }, async () => {
    const server = await testServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain('No discovery document found.')
    expect(output).toContain('MPP servers must serve an OpenAPI document at /openapi.json')
    expect(output).toContain(
      'To test a specific endpoint: mppx validate <url> --endpoint POST:/your/path',
    )
  })

  test('strips /openapi.json from input URL', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', `${server.url}/openapi.json`])
    expect(output).toContain('Document found and parseable')
  })

  test('discovers openapi.json at root when subpath given', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', `${server.url}/mpp`])
    expect(output).toContain('Document found and parseable')
  })

  test('reports invalid JSON', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      if (req.url?.includes('openapi.json')) {
        res.setHeader('Content-Type', 'application/json')
        res.end('not json{{{')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain('Invalid JSON')
  })

  test('handles no paid endpoints in discovery', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      if (req.url?.includes('openapi.json')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'T', version: '1' },
            paths: { '/health': { get: { responses: { '200': {} } } } },
          }),
        )
      } else {
        res.writeHead(200)
        res.end()
      }
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain('Paid endpoints found (No endpoints with x-payment-info)')
    expect(output).toContain('Use --endpoint to specify endpoints manually.')
  })

  test('falls back to 402 response heuristic', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            openapi: '3.1.0',
            info: { title: 'T', version: '1' },
            paths: {
              '/api/data': { get: { responses: { '402': { description: 'Payment required' } } } },
            },
          }),
        )
      } else {
        res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
        res.end()
      }
    })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Paid endpoints found')
    expect(output).toContain('Challenge parseable')
  })
})

describe('validate: challenge', () => {
  test('validates correct MPP challenge', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Challenge parseable (tempo/charge)')
    expect(output).toContain('Challenge has id')
    expect(output).toContain('Challenge has realm')
    expect(output).toContain('Valid recipient address')
    expect(output).toContain('Valid currency address (testnet)')
    expect(output).toContain('Amount is valid integer string')
  })

  test('fails on expired challenge', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge({ expires: '2020-01-01T00:00:00Z' }))
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Challenge expires in the future (Expired at 2020-01-01T00:00:00Z)')
    expect(output).toContain('The expires timestamp must be in the future')
  })

  test('warns on realm mismatch', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge({ realm: 'other.example.com' }))
    const { output } = await serve(['validate', server.url])
    expect(output).toContain(
      'Realm matches server hostname (realm="other.example.com" vs host="localhost")',
    )
    expect(output).toContain('Set the realm to your production hostname')
  })

  test('fails on invalid recipient address', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    ;(challenge.request as Record<string, unknown>).recipient = 'not-an-address'
    const server = await mppServer(challenge)
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Valid recipient address (Got: not-an-address)')
    expect(output).toContain('Set request.recipient to a valid 0x-prefixed 40-hex-char address')
  })

  test('fails on invalid amount', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    ;(challenge.request as Record<string, unknown>).amount = '12.5'
    const server = await mppServer(challenge)
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Amount is valid integer string (Got: 12.5)')
    expect(output).toContain('request.amount must be a string of digits')
  })

  test('detects non-MPP endpoint (x402)', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/test': {} }))
      } else {
        res.writeHead(402, { 'payment-required': 'eyJ0ZXN0IjoxfQ==' })
        res.end()
      }
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(output).toContain('Not an MPP endpoint')
    expect(output).toContain('x402 protocol detected')
    expect(output).toContain('x402 payment challenge')
    expect(exitCode).toBe(1)
  })

  test('skips 200 response', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/test': { method: 'GET' } }))
      } else {
        res.writeHead(200)
        res.end('ok')
      }
    })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain(
      'Returns 402 without credentials (Got 200 (endpoint may not require payment in all cases))',
    )
  })

  test('skips 401 as auth-gated', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/test': {} }))
      } else {
        res.writeHead(401)
        res.end()
      }
    })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain(
      'Returns 402 without credentials (Got 401 (endpoint requires auth before payment gate))',
    )
  })

  test('retries with body on 400', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    const doc = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/api/test': {
          post: {
            'x-payment-info': { method: 'tempo', intent: 'charge', amount: '10000' },
            responses: { '402': {} },
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['q'],
                    properties: { q: { type: 'string', example: 'hello' } },
                  },
                },
              },
            },
          },
        },
      },
    })
    let requestCount = 0
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(doc)
      } else {
        requestCount++
        const hasAuth = req.headers[Constants.Headers.authorization.toLowerCase()]
        if (hasAuth) {
          res.writeHead(402, {
            [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge),
          })
          res.end()
        } else if (requestCount === 1) {
          res.writeHead(400)
          res.end()
        } else {
          res.writeHead(402, {
            [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge),
          })
          res.end()
        }
      }
    })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Challenge parseable')
    expect(requestCount).toBeGreaterThan(1)
  })
})

describe('validate: error handling', () => {
  test('passes when malformed credential returns 402', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Malformed credential returns 402 (not 500)')
  })

  test('fails when malformed credential returns 500', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge(), { errorStatus: 500 })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Malformed credential returns 402 (Got 500 (server error))')
    expect(output).toContain(
      'When the Authorization header contains an invalid credential, respond with 402 (not 500)',
    )
  })

  test('warns when malformed credential returns other status', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge(), { errorStatus: 422 })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Malformed credential returns 402 (Got 422)')
    expect(output).toContain('Returning 422 prevents the client from retrying with a valid payment')
  })
})

describe('validate: --endpoint flag', () => {
  test('checks discovery even with --endpoint', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    const server = await testServer((_req, res) => {
      res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
      res.end()
    })
    const { output } = await serve(['validate', server.url, '--endpoint', 'POST:/api/test'])
    expect(output).toContain('Discovery (/openapi.json)')
    // Discovery fails (server only returns 402) but doesn't block --endpoint testing
    expect(output).toContain('Document found')
    expect(output).toContain('Challenge parseable')
  })

  test('uses --body directly with --endpoint', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    const bodies: string[] = []
    const server = await testServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        bodies.push(body)
        res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
        res.end()
      })
    })
    await serve(['validate', server.url, '--endpoint', 'POST:/api/test', '--body', '{"test":true}'])
    // Challenge phase: bare request first (no body)
    expect(bodies[0]).toBe('')
    // Payment phase: sends body with the credential request
    const paymentRequest = bodies.find((b) => b === '{"test":true}')
    expect(paymentRequest).toBe('{"test":true}')
  })
})

describe('validate: no MPP endpoints', () => {
  test('exits non-zero when all endpoints are x402', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/a': {}, '/api/b': {} }))
      } else {
        res.writeHead(402, { 'payment-required': 'eyJ0ZXN0IjoxfQ==' })
        res.end()
      }
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain('No MPP endpoints found.')
    expect(output).toContain('This server may use x402 or another payment protocol.')
  })

  test('shows auth-gated message when all return 401', { timeout: 15_000 }, async () => {
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/a': {}, '/api/b': {} }))
      } else {
        res.writeHead(401)
        res.end()
      }
    })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain(
      'Could not reach payment gate on any endpoint (all returned 401/403/200).',
    )
    expect(output).toContain('The server may require authentication before payment.')
  })

  test(
    'mixed: some MPP, some not -- does not show "no MPP" message',
    { timeout: 15_000 },
    async () => {
      const challenge = makeChallenge()
      const server = await testServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/openapi.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(makeDiscoveryDoc({ '/api/paid': {}, '/api/free': {} }))
        } else if (url.pathname === '/api/paid') {
          res.writeHead(402, {
            [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge),
          })
          res.end()
        } else {
          res.writeHead(402, { 'payment-required': 'eyJ0ZXN0IjoxfQ==' })
          res.end()
        }
      })
      const { output } = await serve(['validate', server.url])
      expect(output).toContain('Challenge parseable')
      expect(output).toContain('Not an MPP endpoint')
      expect(output).not.toContain('No MPP endpoints found')
    },
  )
})

describe('validate: summary', () => {
  test('shows pass count in summary', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge())
    const { output } = await serve(['validate', server.url])
    expect(output).toMatch(/\d+ passed/)
    expect(output).toContain('Summary:')
  })

  test('shows skipped count when endpoints are skipped', { timeout: 15_000 }, async () => {
    const challenge = makeChallenge()
    const server = await testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/mpp': {}, '/api/free': { method: 'GET' } }))
      } else if (url.pathname === '/api/mpp') {
        res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) })
        res.end()
      } else {
        res.writeHead(200)
        res.end('ok')
      }
    })
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('skipped')
  })

  test('exits non-zero when there are failures', { timeout: 15_000 }, async () => {
    const server = await mppServer(makeChallenge(), { errorStatus: 500 })
    const { output, exitCode } = await serve(['validate', server.url])
    expect(exitCode).toBe(1)
    expect(output).toContain('failed')
  })
})

describe('validate: multi-challenge', () => {
  function makeStripeChallenge(): Challenge.Challenge {
    return {
      id: 'stripe-id-123',
      realm: 'localhost',
      method: 'stripe',
      intent: 'charge',
      request: {
        amount: '100',
        currency: 'usd',
        methodDetails: {
          networkId: 'profile_test123',
          paymentMethodTypes: ['card'],
        },
      },
      expires: new Date(Date.now() + 300_000).toISOString(),
    } as Challenge.Challenge
  }

  function makeEvmChallenge(): Challenge.Challenge {
    return {
      id: 'evm-id-123',
      realm: 'localhost',
      method: 'evm',
      intent: 'charge',
      request: {
        amount: '10000',
        currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        recipient: '0x1234567890123456789012345678901234567890',
        methodDetails: { chainId: 8453, credentialTypes: ['authorization'], decimals: 6 },
      },
      expires: new Date(Date.now() + 300_000).toISOString(),
    } as Challenge.Challenge
  }

  function multiChallengeServer(challenges: Challenge.Challenge[]) {
    const header = challenges.map((c) => Challenge.serialize(c)).join(', ')
    return testServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      if (url.pathname === '/openapi.json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(makeDiscoveryDoc({ '/api/test': {} }))
        return
      }
      res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: header })
      res.end()
    })
  }

  test('parses multiple challenges', { timeout: 15_000 }, async () => {
    const server = await multiChallengeServer([makeChallenge(), makeStripeChallenge()])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('2 methods: tempo/charge, stripe/charge')
  })

  test('validates Stripe fields', { timeout: 15_000 }, async () => {
    const server = await multiChallengeServer([makeStripeChallenge()])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Amount is valid integer string')
    expect(output).toContain('Valid currency code (USD)')
    expect(output).toContain('Has networkId')
    expect(output).toContain('Has paymentMethodTypes (card)')
  })

  test('validates EVM fields', { timeout: 15_000 }, async () => {
    const server = await multiChallengeServer([makeEvmChallenge()])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Valid recipient address')
    expect(output).toContain('Valid currency address')
    expect(output).toContain('Amount is valid integer string')
    expect(output).toContain('Has chainId (8453)')
  })

  test('tags method names when multiple challenges present', { timeout: 15_000 }, async () => {
    const server = await multiChallengeServer([
      makeChallenge(),
      makeStripeChallenge(),
      makeEvmChallenge(),
    ])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('[tempo] Valid recipient address')
    expect(output).toContain('[stripe] Valid currency code')
    expect(output).toContain('[evm] Has chainId')
  })

  test('no tags with single challenge', { timeout: 15_000 }, async () => {
    const server = await multiChallengeServer([makeChallenge()])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Valid recipient address')
    expect(output).not.toContain('[tempo]')
  })

  test('Tempo requires recipient or splits', { timeout: 15_000 }, async () => {
    const noRecipient = makeChallenge({
      request: {
        amount: '10000',
        currency: '0x20c0000000000000000000000000000000000000',
        methodDetails: { chainId: 42431 },
      },
    } as Partial<Challenge.Challenge>)
    const server = await multiChallengeServer([noRecipient])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Missing recipient (and no splits defined)')
  })

  test('Tempo accepts splits without recipient', { timeout: 15_000 }, async () => {
    const withSplits = makeChallenge({
      request: {
        amount: '10000',
        currency: '0x20c0000000000000000000000000000000000000',
        methodDetails: {
          chainId: 42431,
          splits: [
            { amount: '5000', recipient: '0x1234567890123456789012345678901234567890' },
            { amount: '5000', recipient: '0x0987654321098765432109876543210987654321' },
          ],
        },
      },
    } as Partial<Challenge.Challenge>)
    const server = await multiChallengeServer([withSplits])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Uses splits (no single recipient)')
    expect(output).not.toContain('Missing recipient')
  })

  test('fails on invalid Stripe amount', { timeout: 15_000 }, async () => {
    const bad = makeStripeChallenge()
    ;(bad.request as Record<string, unknown>).amount = '1.50'
    const server = await multiChallengeServer([bad])
    const { output } = await serve(['validate', server.url])
    expect(output).toContain('Amount is valid integer string (Got: 1.50)')
  })
})

describe('validate: payment methods coverage', () => {
  test(
    'every method in Constants.Methods produces a payment result',
    { timeout: 15_000 },
    async () => {
      const methods = Object.values(Constants.Methods)
      const challenges = methods.map((method) => ({
        id: `${method}-id`,
        realm: 'localhost',
        method,
        intent: 'charge',
        request: { amount: '100', currency: 'usd', methodDetails: {} },
        expires: new Date(Date.now() + 300_000).toISOString(),
      })) as Challenge.Challenge[]

      const header = challenges.map((c) => Challenge.serialize(c)).join(', ')
      const server = await testServer((req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        if (url.pathname === '/openapi.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              openapi: '3.1.0',
              info: { title: 'T', version: '1' },
              paths: {
                '/api/test': {
                  post: { 'x-payment-info': { amount: '100' }, responses: { '402': {} } },
                },
              },
            }),
          )
          return
        }
        res.writeHead(402, { [Constants.Headers.wwwAuthenticate]: header })
        res.end()
      })
      const { output } = await serve(['validate', server.url, '--outputJson', '--yes'])
      const jsonStart = output.indexOf('{')
      const jsonEnd = output.lastIndexOf('}')
      const result = JSON.parse(output.slice(jsonStart, jsonEnd + 1))
      const paymentLabels = result.endpoints[0].payment.map((r: { label: string }) => r.label)
      for (const method of methods) {
        expect(paymentLabels.some((l: string) => l.includes(`[${method}]`))).toBe(true)
      }
    },
  )
})

describe('validate: JSON mode', () => {
  function mainnetChallenge() {
    return makeChallenge({
      request: {
        amount: '10000',
        currency: '0x20c0000000000000000000000000000000000000',
        recipient: '0x1234567890123456789012345678901234567890',
        methodDetails: { chainId: 4217 },
      },
    } as Partial<Challenge.Challenge>)
  }

  function parseJson(output: string) {
    const jsonStart = output.indexOf('{')
    const jsonEnd = output.lastIndexOf('}')
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1))
  }

  test('does not prompt (non-interactive)', { timeout: 15_000 }, async () => {
    const server = await mppServer(mainnetChallenge())
    const { output } = await serve(['validate', server.url, '--outputJson'])
    const result = parseJson(output)
    const allPayment = result.endpoints.flatMap((ep: { payment: unknown[] }) => ep.payment)
    expect(allPayment.length).toBeGreaterThan(0)
    expect(allPayment.every((r: { severity: string }) => r.severity === 'skip')).toBe(true)
  })

  test('no console leaks before JSON', { timeout: 15_000 }, async () => {
    const server = await mppServer(mainnetChallenge())
    const { output } = await serve(['validate', server.url, '--outputJson', '--yes'])
    const jsonStart = output.indexOf('{')
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    const beforeJson = output.slice(0, jsonStart)
    expect(beforeJson).not.toContain('Using wallet')
    expect(beforeJson).not.toContain('Auto-approved')
    expect(beforeJson).not.toContain('Attempting')
  })

  test('includes suggestions', { timeout: 15_000 }, async () => {
    const server = await mppServer(mainnetChallenge())
    const { output } = await serve(['validate', server.url, '--outputJson', '--yes'])
    const result = parseJson(output)
    expect(Array.isArray(result.suggestions)).toBe(true)
  })
})
