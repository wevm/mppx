import { afterEach, expect, test, vi } from 'vp/test'

import cli from './cli.js'
import * as internal from './internal.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test.each(['https://example.local', 'https://localhost', 'https://app.localhost'])(
  'does not disable TLS for %s',
  async (url) => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1')
    let verification: string | undefined
    const fetch = vi.fn(async (_input: unknown, _init?: unknown) => {
      verification = process.env.NODE_TLS_REJECT_UNAUTHORIZED
      return new Response('ok')
    })
    vi.stubGlobal('fetch', fetch)
    await cli.serve([url, '--silent'], { stdout() {}, exit() {} })
    expect(fetch).toHaveBeenCalled()
    expect(verification).toBe('1')
    expect(fetch.mock.calls[0]?.[0]).toBe(url)
  },
)

test('does not sign or retry a payment over explicitly insecure transport', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 402 }))
  vi.stubGlobal('fetch', fetch)
  let code: number | undefined
  await cli.serve(['https://example.local', '--insecure', '--silent'], {
    stdout() {},
    exit(value) {
      code = value
    },
  })
  expect(code).toBe(2)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each([
  'http://example.com',
  'http://example.local',
  'http://localhost.example.com',
  'http://127.0.0.1.example.com',
  'http://192.168.1.1',
  'http://[::ffff:192.168.1.1]',
])('rejects remote cleartext payment before selecting a signer: %s', async (url) => {
  const select = vi.spyOn(internal, 'selectChallenge')
  const fetch = vi.fn(async () => new Response(null, { status: 402 }))
  vi.stubGlobal('fetch', fetch)
  let output = ''
  await cli.serve([url, '--silent'], {
    stdout(value) {
      output += value
    },
    exit() {},
  })
  expect(output).toContain('INSECURE_PAYMENT')
  expect(select).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each([
  ['https://example.com/start', 'http://example.com/paid'],
  ['http://example.com/start', 'https://example.com/paid'],
  ['https://example.com/start', 'http://example.com/hop', 'https://example.com/paid'],
  ['http://example.com/start', 'http://localhost/paid'],
])('rejects payment after any remote cleartext redirect hop: %j', async (...urls) => {
  const select = vi.spyOn(internal, 'selectChallenge')
  let index = 0
  const fetch = vi.fn(async () => {
    const location = urls[++index]
    return location
      ? new Response(null, { status: 302, headers: { location } })
      : new Response(null, { status: 402 })
  })
  vi.stubGlobal('fetch', fetch)
  let output = ''
  await cli.serve([urls[0]!, '--location', '--silent'], {
    stdout(value) {
      output += value
    },
    exit() {},
  })
  expect(output).toContain('INSECURE_PAYMENT')
  expect(select).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(urls.length)
})

test.each([
  'https://example.com',
  'http://localhost',
  'http://127.0.0.1',
  'http://[::1]',
  'http://app.localhost',
])('allows challenge processing over trusted transport: %s', async (url) => {
  const fetch = vi.fn(async () => new Response(null, { status: 402 }))
  vi.stubGlobal('fetch', fetch)
  let output = ''
  await cli.serve([url, '--silent'], {
    stdout(value) {
      output += value
    },
    exit() {},
  })
  expect(output).toContain('UNSUPPORTED_PROTOCOL')
  expect(output).not.toContain('INSECURE_PAYMENT')
})

test('allows non-payment responses over remote HTTP', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('public content')),
  )
  const exit = vi.fn()
  await cli.serve(['http://example.com', '--silent'], { stdout() {}, exit })
  expect(exit).not.toHaveBeenCalledWith(2)
})
