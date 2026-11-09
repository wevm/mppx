import type { RequestListener } from 'node:http'

import { Credential, Method, Receipt, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Identity from 'mppx/identity'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { afterEach, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

const method = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})
const clientMethod = Method.toClient(method, {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'paid' } })
  },
})
let settlements = 0
const serverMethod = Method.toServer(method, {
  async verify() {
    settlements++
    return Receipt.from({
      method: 'test',
      reference: 'test-payment',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
const charge = { amount: '1', currency: 'USD', recipient: 'merchant' } as const

const servers: { close(): void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** A lookup in the server's own customer table, as an app would do. */
const customers = new Map([['key-1', { customer: 'acme', plan: 'pro' }]])
const apiKey = Identity.from({
  challenge: { 'WWW-Authenticate': 'ApiKey' },
  async verify(request) {
    const key = request.headers.get('X-Api-Key')
    if (!key) return undefined
    const row = customers.get(key)
    if (!row) throw new Identity.Rejection('Unknown API key.', { code: 403 })
    return row
  },
})

async function createServer() {
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const listener = ServerRequest.toNodeListener(async (request) => {
    const result = await mppx.charge({ ...charge, identity: [apiKey] })(request)
    if (result.status === 402) return result.challenge
    return result.withReceipt(Response.json(result.identity?.get(apiKey)))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  servers.push(server)
  return server
}

test("gates a paid route on the server's own identity lookup", async () => {
  const server = await createServer()
  const before = settlements

  const missing = await fetch(server.url)
  expect(missing.status).toBe(401)
  expect(missing.headers.get('WWW-Authenticate')).toBe('ApiKey')

  const rejected = await fetch(server.url, { headers: { 'X-Api-Key': 'wrong' } })
  expect(rejected.status).toBe(403)
  expect(await rejected.text()).toBe('Unknown API key.')

  // Identity passes, so the route asks for payment.
  const verified = await fetch(server.url, { headers: { 'X-Api-Key': 'key-1' } })
  expect(verified.status).toBe(402)
  expect(settlements).toBe(before)

  const client = ClientMppx.create({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set('X-Api-Key', 'key-1')
      return fetch(request)
    },
    methods: [clientMethod],
    polyfill: false,
  })
  const paid = await client.fetch(server.url)
  expect(paid.status).toBe(200)
  expect(await paid.json()).toEqual({ customer: 'acme', plan: 'pro' })
  expect(settlements).toBe(before + 1)
})

test('composes with other verifiers through anyOf', async () => {
  const header = Identity.from({ verify: (request) => request.headers.get('X-Team') ?? undefined })
  const either = Identity.anyOf(apiKey, header)
  expect(
    await either.verify(new Request('https://api.example', { headers: { 'X-Team': 'ops' } })),
  ).toEqual({ status: 'valid', value: { index: 1, value: 'ops' } })
  expect(await either.verify(new Request('https://api.example'))).toMatchObject({
    status: 'missing',
  })
})

test('rethrows errors that are not rejections', async () => {
  const broken = Identity.from({
    verify() {
      throw new Error('database down')
    },
  })
  await expect(broken.verify(new Request('https://api.example'))).rejects.toThrow('database down')
})

test('treats a null lookup result as no identity', async () => {
  const lookup = Identity.from({ verify: () => null })
  const result = await lookup.verify(new Request('http://localhost'))
  expect(result).toEqual({ status: 'missing', reason: 'Identity verification is required.' })
})

test('Rejection carries a fixed status; the deprecated code still maps to one', async () => {
  const reject = (options: ConstructorParameters<typeof Identity.Rejection>[1]) =>
    Identity.from({
      challenge: { 'WWW-Authenticate': 'ApiKey' },
      verify() {
        throw new Identity.Rejection('no', options)
      },
    }).verify(new Request('https://api.example'))
  const headers = { 'WWW-Authenticate': 'ApiKey' }
  expect(await reject({})).toEqual({ status: 'invalid', headers, reason: 'no' })
  expect(await reject({ status: 'forbidden' })).toEqual({
    status: 'forbidden',
    headers,
    reason: 'no',
  })
  expect(await reject({ status: 'unavailable' })).toMatchObject({ status: 'unavailable' })
  expect(await reject({ code: 403 })).toMatchObject({ status: 'forbidden' })
  expect(await reject({ code: 503 })).toMatchObject({ status: 'unavailable' })
  expect(await reject({ code: 400 })).toEqual({
    status: 'invalid',
    code: 400,
    headers,
    reason: 'no',
  })
  expect(new Identity.Rejection('no', { status: 'forbidden' }).code).toBe(403)
})
