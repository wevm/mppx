import { request } from 'node:http'

import express from 'express'
import { Mppx, payment } from 'mppx/express'
import { Mppx as Core, Store, tempo } from 'mppx/server'
import { afterEach, expect, test, vi } from 'vp/test'

import { toRequest } from './internal/express.js'

const servers: ReturnType<ReturnType<typeof express>['listen']>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

test.each(['factory', 'payment'] as const)(
  'rejects an unapproved Host before verification through %s',
  async (mode) => {
    const app = express()
    const config = {
      methods: [
        tempo.charge({
          store: Store.memory(),
          currency: '0x20c0000000000000000000000000000000000000',
          recipient: '0x0000000000000000000000000000000000000001',
        }),
      ],
      secretKey: 'test-secret-key-test-secret-key-32',
    } as const
    const handler =
      mode === 'factory'
        ? Mppx.create({ ...config, allowedHosts: ['trusted.example'] }).charge({
            amount: '1',
          })
        : payment(
            Core.create(config).charge,
            { amount: '1' },
            { allowedHosts: ['trusted.example'] },
          )
    const urls: string[] = []
    app.use((req, _res, next) => {
      urls.push(toRequest(req).url)
      next()
    })
    app.get('/paid', handler, (_req, res) => res.send('protected'))
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listener address')
    const response = await send(`http://localhost:${address.port}/paid`, {
      headers: { Host: 'attacker.example' },
    })
    expect(response.status).toBe(421)
    expect(await response.text()).toBe('Misdirected Request')
    const allowed = await send(`http://localhost:${address.port}/paid`, {
      headers: { Host: 'trusted.example' },
    })
    expect(allowed.status).toBe(402)
    const duplicate = await send(`http://localhost:${address.port}/paid`, {
      headers: ['Host', 'trusted.example', 'Host', 'denied.example'],
    })
    expect(duplicate.status).toBe(421)
    const absolute = await send(`http://localhost:${address.port}/paid`, {
      headers: { Host: 'trusted.example' },
      path: 'http://denied.example/paid',
    })
    expect(absolute.status).toBe(402)
    expect(urls.at(-1)).toBe('http://trusted.example/paid')
  },
)

function send(
  url: string,
  options: { headers: { Host: string } | string[]; path?: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve(new Response(body, { status: res.statusCode ?? 500 })))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

test('Mppx Node listener returns 421 without running the payment handler', async () => {
  const handler = vi.fn(async () => ({
    status: 402 as const,
    challenge: new Response(null, { status: 402 }),
  }))
  const app = express()
  app.use(Core.toNodeListener(handler, { allowedHosts: ['trusted.example'] }))
  const server = app.listen(0)
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener address')
  const response = await send(`http://localhost:${address.port}/paid`, {
    headers: { Host: 'denied.example' },
  })
  expect(response.status).toBe(421)
  expect(handler).not.toHaveBeenCalled()
})
