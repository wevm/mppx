import { once } from 'node:events'
import { createServer } from 'node:http'

import { expect, test } from 'vp/test'

import * as Fetch from './Fetch.js'

for (const status of [301, 302, 303, 307, 308]) {
  test(`paid ${status} does not forward Payment-Authorization`, async () => {
    let contacted = false
    let leaked = false
    const target = createServer((req, res) => {
      contacted = true
      leaked = Boolean(req.headers['payment-authorization'])
      res.end('ok')
    }).listen(0, '127.0.0.1')
    await once(target, 'listening')
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/`
    const request = Buffer.from(JSON.stringify({ amount: '1' })).toString('base64url')
    const origin = createServer((req, res) => {
      if (req.headers['payment-authorization']) {
        res.writeHead(status, { location: targetUrl }).end()
      } else {
        res
          .writeHead(402, {
            'www-authenticate': `Payment id="fresh", realm="local", method="test", intent="test", request="${request}", header="Payment-Authorization"`,
          })
          .end()
      }
    }).listen(0, '127.0.0.1')
    await once(origin, 'listening')
    try {
      const fetch = Fetch.from({
        methods: [
          {
            name: 'test',
            intent: 'test',
            context: undefined,
            createCredential: async () => 'Payment dummy-credential',
          } as any,
        ],
      })
      const response = await fetch(
        `http://127.0.0.1:${(origin.address() as { port: number }).port}/`,
        {
          redirect: 'follow',
        },
      )
      expect(response.status).toBe(status)
      expect(contacted).toBe(false)
      expect(leaked).toBe(false)
    } finally {
      origin.closeAllConnections()
      origin.close()
      target.closeAllConnections()
      target.close()
    }
  })
}
