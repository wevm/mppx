import { afterEach, expect, test, vi } from 'vp/test'

import cli from './cli.js'

afterEach(() => {
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
