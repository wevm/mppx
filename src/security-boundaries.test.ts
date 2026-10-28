import express from 'express'
import { describe, expect, test, vi } from 'vp/test'
import { keyPair } from '~test/Identity.js'

import * as Credential from './Credential.js'
import * as HttpMessageSignature from './extensions/identity/internal/HttpMessageSignature.js'
import * as Method from './Method.js'
import { payment } from './middlewares/express.js'
import * as Mppx from './server/Mppx.js'
import * as Store from './Store.js'
import * as z from './zod.js'

const secretKey = 'test-secret-key-test-secret-key-32'
const request = { amount: '1' }
function method() {
  return Method.toServer(
    Method.from({
      name: 'test',
      intent: 'charge',
      schema: {
        request: z.object({ amount: z.string() }),
        credential: { payload: z.object({}) },
      },
    }),
    {
      validate: vi.fn(async ({ credential, request }) => ({
        challenge: credential.challenge,
        credential,
        details: {},
        intent: 'charge' as const,
        method: 'test' as const,
        request,
      })),
      broadcast: vi.fn(async () => ({
        method: 'test',
        status: 'success' as const,
        reference: 'test',
        timestamp: new Date().toISOString(),
      })),
    },
  )
}

describe('standalone realm boundaries', () => {
  test.each(['broadcastCredential', 'verifyCredential', 'validateCredential'] as const)(
    '%s rejects foreign and unconfigured realms',
    async (api) => {
      const m = method()
      const issuer = Mppx.create({ methods: [m], secretKey, realm: 'a' })
      const challenge = await issuer.challenge.test.charge(request)
      const credential = Credential.from({ challenge, payload: {} })
      for (const realm of ['b', undefined]) {
        const receiver = Mppx.create({ methods: [m], secretKey, realm })
        await expect(receiver[api](credential)).rejects.toThrow('matching configured realm')
        await expect(receiver[api](credential, { scope: 'test' })).rejects.toThrow()
        await expect(receiver[api](credential, { request })).rejects.toThrow()
        await expect(receiver[api](credential, { meta: {} })).rejects.toThrow()
      }
      expect(m.broadcast).not.toHaveBeenCalled()
      await expect(issuer.broadcastCredential(credential)).resolves.toMatchObject({
        status: 'success',
      })
    },
  )
})

describe('expiry at authorization commit', () => {
  test.each([true, false])('rejects expired claims (optimized: %s)', async (optimized) => {
    const backing = Store.memory()
    const store = optimized ? backing : { ...backing, tryClaim: undefined }
    for (const expiry of [Date.now() - 1, Date.now(), NaN, Infinity])
      expect(await Store.tryClaim(store, 'key', expiry)).toBe(false)
    expect(await backing.get('key')).toBeNull()
  })

  test('rejects claims delayed past expiry inside atomic update', async () => {
    vi.useFakeTimers()
    try {
      const backing = Store.memory()
      const expires = Date.now() + 100
      const store: Store.AtomicStore = {
        ...backing,
        tryClaim: undefined,
        async update(key, fn) {
          vi.advanceTimersByTime(101)
          return backing.update(key, fn)
        },
      }
      expect(await Store.tryClaim(store, 'key', expires)).toBe(false)
      expect(await backing.get('key')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test.each(['key', 'claim'])(
    'rejects signatures crossing expiry during %s resolution',
    async (delay) => {
      vi.useFakeTimers()
      try {
        const keys = await keyPair()
        const signed = await HttpMessageSignature.sign(new Request('https://example.test'), {
          components: ['@authority'],
          key: keys.privateKey,
          keyId: 'test',
          label: 'sig',
          tag: 'test',
          expiresIn: 1,
        })
        const store = Store.memory()
        const result = await HttpMessageSignature.verify(signed, {
          keyResolver: async () => {
            if (delay === 'key') vi.advanceTimersByTime(2000)
            return keys.publicKey
          },
          maxAge: 60,
          nonceNamespace: 'test',
          nonceStore: {
            ...store,
            async tryClaim(key, expiry) {
              const claimed = await store.tryClaim!(key, expiry)
              if (delay === 'claim') vi.advanceTimersByTime(2000)
              return claimed
            },
          },
          requiredComponents: ['@authority'],
          tag: 'test',
        })
        expect(result.status).toBe('invalid')
      } finally {
        vi.useRealTimers()
      }
    },
  )
})

describe('Express wrapped response', () => {
  test('preserves Express JSON replacer, spacing, and HTML escaping', async () => {
    const app = express()
    app.set('json spaces', 2)
    app.set('json escape', true)
    app.set('json replacer', (key: string, value: unknown) =>
      key === 'secret' ? undefined : typeof value === 'bigint' ? String(value) : value,
    )
    const body = { secret: 'private', amount: 1n, html: '<script>&' }
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt(response?: Response) {
        if (!response) throw new Mppx.MissingReceiptResponseError()
        return response
      },
    })
    app.get('/plain', (_req, res) => res.json(body))
    app.get('/paid', payment(intent, {}), (_req, res) => res.json(body))
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const plain = await fetch(`http://localhost:${port}/plain`)
      const paid = await fetch(`http://localhost:${port}/paid`)
      expect(paid.status).toBe(200)
      expect(paid.headers.get('content-type')).toBe(plain.headers.get('content-type'))
      const expected = await plain.text()
      expect(expected).not.toContain('private')
      expect(expected).not.toContain('<script>')
      expect(await paid.text()).toBe(expected)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test.each([200, 201, 204, 402])('propagates transport status and body: %s', async (status) => {
    const app = express()
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt(response?: Response) {
        if (!response) throw new Mppx.MissingReceiptResponseError()
        return status === 402
          ? new Response('payment required', { status, headers: { 'WWW-Authenticate': 'Payment' } })
          : response
      },
    })
    app.post('/', payment(intent, {}), (_req, res) =>
      res.status(status === 402 ? 200 : status).json({ protected: true }),
    )
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const response = await fetch(`http://localhost:${port}`, { method: 'POST', body: 'billable' })
      expect(response.status).toBe(status)
      if (status === 402) {
        expect(await response.text()).toBe('payment required')
        expect(response.headers.get('WWW-Authenticate')).toBe('Payment')
      } else if (status === 204) expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual({ protected: true })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
