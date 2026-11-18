import { request } from 'node:http'

import express from 'express'
import { Mppx, payment } from 'mppx/express'
import { Mppx as Core, Request as NodeRequest, Store, tempo } from 'mppx/server'
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
    app.set('trust proxy', true)
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
    app.get(['/paid', '//private/paid', '//%/paid'], handler, (_req, res) => res.send('protected'))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listener address')
    const response = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Host: 'attacker.example' },
    })
    expect(response.status).toBe(421)
    expect(await response.text()).toBe('Misdirected Request')
    const allowed = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Host: 'trusted.example' },
    })
    expect(allowed.status).toBe(402)
    const duplicate = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: ['Host', 'trusted.example', 'Host', 'denied.example'],
    })
    expect(duplicate.status).toBe(421)
    const absolute = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Host: 'trusted.example' },
      path: 'http://denied.example/paid',
    })
    expect(absolute.status).toBe(402)
    expect(urls.at(-1)).toBe('http://trusted.example/paid')
    const protocol = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: ['Host', 'trusted.example', 'X-Forwarded-Proto', 'https://denied.example/#'],
    })
    expect(protocol.status).toBe(421)
    const mixedCase = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: ['Host', 'trusted.example', 'X-Forwarded-Proto', 'hTtPs'],
    })
    expect(mixedCase.status).toBe(402)
    expect(urls.at(-1)).toBe('https://trusted.example/paid')
    const https = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: ['Host', 'trusted.example', 'X-Forwarded-Proto', 'https'],
    })
    expect(https.status).toBe(402)
    expect(urls.at(-1)).toBe('https://trusted.example/paid')
    for (const path of ['//private/paid', '//%/paid']) {
      const preserved = await send(`http://127.0.0.1:${address.port}/paid`, {
        headers: { Host: 'trusted.example' },
        path,
      })
      expect(preserved.status).toBe(402)
      expect(urls.at(-1)).toBe(`http://trusted.example${path}`)
    }
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
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener address')
  const response = await send(`http://127.0.0.1:${address.port}/paid`, {
    headers: { Host: 'denied.example' },
  })
  expect(response.status).toBe(421)
  expect(handler).not.toHaveBeenCalled()
})

test('Node listener keeps 421 when a custom error observer returns void', async () => {
  const handler = vi.fn(() => new Response('unexpected'))
  const onError = vi.fn()
  const app = express()
  app.use(NodeRequest.toNodeListener(handler, { allowedHosts: ['trusted.example'], onError }))
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No listener address')
  const response = await send(`http://127.0.0.1:${address.port}/paid`, {
    headers: { Host: 'denied.example' },
  })
  expect(response.status).toBe(421)
  expect(onError).toHaveBeenCalledOnce()
  expect(handler).not.toHaveBeenCalled()
})

test.each([true, false])(
  'Node listener logs handler errors only without a custom observer: %s',
  async (observed) => {
    const error = new Error('private upstream detail')
    const onError = vi.fn()
    const options = { onError: observed ? onError : undefined }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = express()
      app.use(
        NodeRequest.toNodeListener(() => {
          throw error
        }, options),
      )
      options.onError = undefined
      const server = app.listen(0, '127.0.0.1')
      servers.push(server)
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No listener address')
      const response = await send(`http://127.0.0.1:${address.port}/paid`, {
        headers: { Host: 'trusted.example' },
      })
      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Internal Server Error')
      if (observed) {
        expect(onError).toHaveBeenCalledWith(error)
        expect(log).not.toHaveBeenCalled()
      } else expect(log).toHaveBeenCalledWith(error)
    } finally {
      log.mockRestore()
    }
  },
)

test.each([undefined, ['trusted.example']])(
  'Express rejects malformed targets before payment with allowedHosts %s',
  async (allowedHosts) => {
    const intent = vi.fn(() =>
      vi.fn(async () => ({ status: 402 as const, challenge: new Response(null, { status: 402 }) })),
    )
    const app = express()
    app.use(payment(intent, {}, { allowedHosts }))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listener address')
    const response = await send(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Host: 'trusted.example' },
      path: 'http://trusted.example:99999/paid',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('Bad Request')
    expect(intent).not.toHaveBeenCalled()
  },
)
