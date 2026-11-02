import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Fetch from '../../client/internal/Fetch.js'
import * as Mppx from '../../client/Mppx.js'
import * as Method from '../../Method.js'
import { validate } from '../../validation/core.js'
import * as z from '../../zod.js'
import { fetchWithTimeout } from './helpers.js'

describe('fetchWithTimeout', () => {
  test.each([301, 302, 303, 307, 308])(
    'rejects HTTP %s without forwarding a probe',
    async (status) => {
      const requests: string[] = []
      const server = createServer((request, response) => {
        requests.push(request.url!)
        if (request.url === '/probe') {
          response.writeHead(status, { location: '/private' })
        }
        response.end('ok')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      try {
        for (const method of ['GET', 'POST', 'DELETE']) {
          await expect(
            fetchWithTimeout(`${url}/probe`, {
              method,
              redirect: 'follow',
              ...(method === 'POST' ? { body: 'private request body' } : {}),
            }),
          ).rejects.toThrow()
        }
        expect(requests).toEqual(['/probe', '/probe', '/probe'])
        expect(await (await fetchWithTimeout(`${url}/ok`, {})).text()).toBe('ok')
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )
})

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'validation probes bypass payments and preserve identity (%s, layered %s)',
  async (withIdentity, layered) => {
    const original = globalThis.fetch
    const createCredential = vi.fn(async () => 'credential')
    const method = Method.toClient(
      Method.from({
        name: 'test',
        intent: 'charge',
        schema: { credential: { payload: z.object({}) }, request: z.object({}) },
      }),
      { createCredential },
    )
    const challenge = Challenge.from({
      id: 'probe',
      realm: 'example.test',
      method: 'test',
      intent: 'charge',
      request: {},
    })
    const requests: Request[] = []
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init))
      return new Response('', {
        status: 402,
        headers: {
          'WWW-Authenticate': Challenge.serialize(challenge),
        },
      })
    }
    try {
      Mppx.create({
        methods: [method],
        ...(withIdentity && {
          identity: [
            {
              scope: '*',
              prove(request: Request) {
                const headers = new Headers(request.headers)
                headers.set('Signature', 'probe-identity')
                return new Request(request, { headers })
              },
            },
          ],
        }),
      })
      const installed = globalThis.fetch
      if (layered) globalThis.fetch = (input, init) => installed(input, { ...init })
      const wrapped = globalThis.fetch
      await validate({ url: 'https://example.test', endpoint: 'GET:/paid', skipPayment: true })
      expect(createCredential).not.toHaveBeenCalled()
      expect(requests.length).toBeGreaterThan(0)
      expect(
        requests.every((request) => request.headers.get('Authorization') !== 'credential'),
      ).toBe(true)
      expect(
        requests.every(
          (request) =>
            request.headers.get('Signature') === (withIdentity ? 'probe-identity' : null),
        ),
      ).toBe(true)
      expect(globalThis.fetch).toBe(wrapped)
    } finally {
      Fetch.restore()
      globalThis.fetch = original
    }
  },
)
