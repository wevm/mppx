import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, test } from 'vp/test'

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
