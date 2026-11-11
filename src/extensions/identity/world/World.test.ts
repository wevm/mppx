import type { RequestListener } from 'node:http'

import { Challenge, Credential, Method, Receipt, Store, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as World from 'mppx/extensions/identity/world'
import { Mppx, Request as ServerRequest } from 'mppx/server'
import { Base64 } from 'ox'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const humanId = 0x2a5n

/** A fake AgentBook: `lookupHuman` returns the registered human, or 0. */
function agentBook(registered: Record<string, bigint>, options: { fail?: boolean } = {}) {
  const calls: unknown[] = []
  return {
    calls,
    client: {
      async readContract(parameters: { address: string; args: [string] }) {
        calls.push(parameters)
        if (options.fail) throw new Error('rpc down')
        return registered[parameters.args[0].toLowerCase()] ?? 0n
      },
    },
  }
}

/** Smart-account clients that never reach the network and accept nothing. */
const offline = { 480: { verifyMessage: async () => false } }

/** Required settings: the test origin and an RPC no test reaches. */
const base = { origins: ['https://api.example'], rpcUrl: 'http://127.0.0.1:1' }

const registered = () => agentBook({ [account.address.toLowerCase()]: humanId })

let attempt = 0
async function signed(url = 'https://api.example/report', signer = account) {
  const prover = World.Client.prover({ account: signer, scope: '*' })
  return prover.prove(new Request(url), {
    created: Math.floor(Date.now() / 1000),
    nonce: `attempt-${++attempt}-${Math.random()}`,
  })
}

test('accepts a registered agent and returns its human', async () => {
  const book = registered()
  const verifier = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: book,
    nonceStore: Store.memory(),
  })
  const result = await verifier.verify(await signed())
  expect(result).toEqual({
    status: 'valid',
    value: { address: account.address, chainId: 'eip155:480', humanId: '0x2a5' },
  })
  expect(book.calls[0]).toMatchObject({ address: World.Constants.agentBook })
})

test('sends the AgentKit payload in the agentkit header', async () => {
  const request = await signed()
  const payload = JSON.parse(Base64.toString(request.headers.get('agentkit')!))
  expect(payload).toMatchObject({
    domain: 'api.example',
    address: account.address,
    uri: 'https://api.example/report',
    version: '1',
    chainId: 'eip155:480',
    type: 'eip191',
  })
  expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/)
})

test('rejects a missing, unregistered, replayed, tampered or misdirected message', async () => {
  const nonceStore = Store.memory()
  const verifier = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: agentBook({}),
    nonceStore,
  })
  expect(await verifier.verify(new Request('https://api.example'))).toMatchObject({
    status: 'missing',
  })

  const unregistered = await verifier.verify(await signed())
  expect(unregistered).toMatchObject({ status: 'forbidden' })
  expect(unregistered.status === 'forbidden' && unregistered.reason).toContain(
    'agentkit-cli register',
  )

  const once = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: registered(),
    nonceStore: Store.memory(),
  })
  const request = await signed()
  expect((await once.verify(request.clone())).status).toBe('valid')
  expect(await once.verify(request)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('already been used'),
  })

  const original = await signed()
  const payload = JSON.parse(Base64.toString(original.headers.get('agentkit')!))
  const tampered = new Request(original.url, {
    headers: {
      agentkit: Base64.fromString(
        JSON.stringify({ ...payload, address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }),
      ),
    },
  })
  expect(await once.verify(tampered)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('signature'),
  })

  const elsewhere = await signed('https://other.example/report')
  const moved = new Request('https://api.example/report', { headers: elsewhere.headers })
  expect(await once.verify(moved)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('another URI'),
  })

  expect(
    await once.verify(new Request('https://api.example', { headers: { agentkit: 'nope' } })),
  ).toMatchObject({
    status: 'invalid',
  })
})

test('rejects a stale message and maps an AgentBook outage to unavailable', async () => {
  const prover = World.Client.prover({ account, scope: '*' })
  const stale = await prover.prove(new Request('https://api.example'), {
    created: Math.floor(Date.now() / 1000) - 600,
    nonce: 'stale-attempt',
  })
  const verifier = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: registered(),
    nonceStore: Store.memory(),
  })
  expect(await verifier.verify(stale)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('too old'),
  })

  const down = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: agentBook({}, { fail: true }),
    nonceStore: Store.memory(),
  })
  expect(await down.verify(await signed())).toMatchObject({ status: 'unavailable' })
})

test('gates a paid route before its 402', async () => {
  const method = Method.toServer(
    Method.from({
      name: 'test',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
      },
    }),
    {
      async verify() {
        return Receipt.from({
          method: 'test',
          reference: 'r',
          status: 'success',
          timestamp: new Date().toISOString(),
        })
      },
    },
  )
  const mppx = Mppx.create({
    methods: [method],
    realm: 'api.example',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const human = World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: registered(),
    nonceStore: Store.memory(),
  })
  const route = mppx.charge({
    amount: '1',
    currency: 'USD',
    recipient: 'merchant',
    identity: [human],
  })

  const anonymous = await route(new Request('https://api.example/report'))
  expect(anonymous.status === 402 && anonymous.challenge.status).toBe(401)
  const agent = await route(await signed())
  expect(agent.status === 402 && agent.challenge.status).toBe(402)
})

test('verifies smart-account signatures on the signing chain only', async () => {
  // A smart account's signature does not recover to its address: the chain decides.
  const owner = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
  const smartAccount = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' as const
  const book = agentBook({ [smartAccount.toLowerCase()]: humanId })
  const checked: unknown[] = []
  const prover = World.Client.prover({
    account: { address: smartAccount, signMessage: owner.signMessage },
    chainId: 8453,
    scope: '*',
    type: 'eip1271',
  })
  const prove = (nonce: string) =>
    prover.prove(new Request('https://api.example'), {
      created: Math.floor(Date.now() / 1000),
      nonce,
    })

  const verifier = World.Server.verifier({
    ...base,
    agentBook: book,
    clients: {
      8453: {
        async verifyMessage(parameters) {
          checked.push(parameters.address)
          return parameters.address === smartAccount
        },
      },
    },
    nonceStore: Store.memory(),
  })
  expect(await verifier.verify(await prove('smart-1'))).toMatchObject({
    status: 'valid',
    value: { address: smartAccount, chainId: 'eip155:8453' },
  })
  expect(checked).toEqual([smartAccount])

  // No client for the signing chain: rejected without an RPC call.
  const elsewhere = World.Server.verifier({
    ...base,
    agentBook: book,
    clients: {},
    nonceStore: Store.memory(),
    rpcUrls: {},
  })
  const onMainnet = World.Client.prover({
    account: { address: smartAccount, signMessage: owner.signMessage },
    chainId: 1,
    scope: '*',
  })
  expect(
    await elsewhere.verify(
      await onMainnet.prove(new Request('https://api.example'), {
        created: Math.floor(Date.now() / 1000),
        nonce: 'smart-2',
      }),
    ),
  ).toMatchObject({ status: 'invalid' })

  const down = World.Server.verifier({
    ...base,
    agentBook: book,
    clients: {
      8453: {
        verifyMessage: async () => {
          throw new Error('rpc down')
        },
      },
    },
    nonceStore: Store.memory(),
  })
  expect(await down.verify(await prove('smart-3'))).toMatchObject({ status: 'unavailable' })
})

/** Signs an AgentKit payload as @worldcoin/agentkit's client does, with fields overridden. */
async function craft(
  overrides: Record<string, unknown> = {},
  options: { url?: string; target?: string; signer?: typeof account; signature?: string } = {},
) {
  const url = options.url ?? 'https://api.example/report'
  const fields = {
    domain: new URL(url).hostname,
    address: (options.signer ?? account).address,
    statement: World.Constants.statement,
    uri: url,
    version: '1',
    chainId: 'eip155:480',
    type: 'eip191',
    nonce: 'n' + ++attempt + Math.random().toString(36).slice(2),
    issuedAt: new Date().toISOString(),
    ...overrides,
  } as World.Payload
  let signature = options.signature
  if (!signature)
    try {
      signature = await (options.signer ?? account).signMessage({
        message: World.Client.message(fields),
      })
    } catch {
      signature = '0x'
    }
  return new Request(options.target ?? url, {
    headers: { agentkit: Base64.fromString(JSON.stringify({ ...fields, signature })) },
  })
}

const verifierFor = (config: Partial<World.Server.verifier.Config> = {}) =>
  World.Server.verifier({
    ...base,
    clients: offline,
    agentBook: registered(),
    nonceStore: Store.memory(),
    ...config,
  })

const key = (byte: string) => privateKeyToAccount(('0x' + byte.repeat(32)) as never)

test('builds the same SIWE message as @worldcoin/agentkit', () => {
  // Generated with formatSIWEMessage from @worldcoin/agentkit 0.2.1.
  const expected =
    'api.example wants you to sign in with your Ethereum account:\n0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1\n\nVerify your agent is backed by a real human\n\nURI: https://api.example/report\nVersion: 1\nChain ID: 480\nNonce: 0123456789abcdef\nIssued At: 2026-11-10T00:00:00.000Z\nRequest ID: chal_1\nResources:\n- https://api.example/a'
  expect(
    World.Client.message({
      domain: 'api.example',
      address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
      statement: 'Verify your agent is backed by a real human',
      uri: 'https://api.example/report',
      version: '1',
      chainId: 'eip155:480',
      type: 'eip191',
      nonce: '0123456789abcdef',
      issuedAt: '2026-11-10T00:00:00.000Z',
      requestId: 'chal_1',
      resources: ['https://api.example/a'],
    }),
  ).toBe(expected)
})

test('accepts payloads with the optional AgentKit fields', async () => {
  const verifier = verifierFor()
  for (const overrides of [
    { statement: undefined },
    { expirationTime: new Date(Date.now() + 60_000).toISOString() },
    { notBefore: new Date(Date.now() - 1_000).toISOString() },
    { requestId: 'chal_1', resources: ['https://api.example/a'] },
    // Unknown fields, such as AgentKit's signatureScheme, are ignored.
    { signatureScheme: 'eip191' },
  ])
    expect((await verifier.verify(await craft(overrides))).status).toBe('valid')
})

test('enforces the message lifetime', async () => {
  const verifier = verifierFor({ maxAge: 60 })
  const at = (offset: number) => new Date(Date.now() + offset).toISOString()
  const cases: [Record<string, unknown>, string][] = [
    [{ issuedAt: at(-55_000) }, 'valid'],
    [{ issuedAt: at(-65_000) }, 'too old'],
    [{ issuedAt: at(20_000) }, 'valid'],
    [{ issuedAt: at(40_000) }, 'future'],
    [{ issuedAt: 'yesterday' }, 'issuedAt'],
    [{ expirationTime: at(-1) }, 'expired'],
    [{ expirationTime: 'never' }, 'expired'],
    [{ notBefore: at(60_000) }, 'not valid yet'],
  ]
  for (const [overrides, expected] of cases) {
    const result = await verifier.verify(await craft(overrides))
    if (expected === 'valid') expect(result.status).toBe('valid')
    else
      expect(result).toMatchObject({
        status: 'invalid',
        reason: expect.stringContaining(expected),
      })
  }
})

test('binds the message to the origin, including its port', async () => {
  const local = verifierFor({ origins: ['http://localhost:8787'] })
  expect(
    (await local.verify(await craft({}, { url: 'http://localhost:8787/report' }))).status,
  ).toBe('valid')
  expect(
    await local.verify(await craft({}, { url: 'http://localhost:9999/report' })),
  ).toMatchObject({ status: 'invalid', reason: expect.stringContaining('URI') })
  const verifier = verifierFor()
  // Another path on the same host is accepted: AgentKit binds the host, not the path.
  expect(
    (await verifier.verify(await craft({}, { target: 'https://api.example/other' }))).status,
  ).toBe('valid')
  expect(await verifier.verify(await craft({ uri: 'not a url' }))).toMatchObject({
    status: 'invalid',
  })
  expect(await verifier.verify(await craft({ domain: 'evil.example' }))).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('domain'),
  })
})

test('rejects malformed headers without throwing', async () => {
  const verifier = verifierFor()
  for (const value of [
    'nope',
    Base64.fromString('null'),
    Base64.fromString('[]'),
    Base64.fromString('{"domain":1}'),
  ])
    expect(
      await verifier.verify(new Request('https://api.example', { headers: { agentkit: value } })),
    ).toMatchObject({ status: 'invalid' })

  for (const overrides of [
    { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
    { chainId: '480' },
    { address: '0x1234' },
    { address: 'So11111111111111111111111111111111111111112' },
    { type: 'ed25519' },
    { version: 2 },
    { resources: {} },
    { resources: [1] },
    { requestId: 7 },
    { statement: ['x'] },
    // Fields viem refuses to put in a SIWE message.
    { nonce: 'short' },
    { nonce: 'not-alphanumeric!' },
    { statement: 'line\nbreak' },
  ])
    expect(await verifier.verify(await craft(overrides))).toMatchObject({ status: 'invalid' })
})

test('derives a valid SIWE nonce from any attempt nonce', async () => {
  const verifier = verifierFor()
  const prover = World.Client.prover({ account, scope: '*' })
  for (const nonce of ['a', '-_', 'x'.repeat(200)]) {
    const request = await prover.prove(new Request('https://api.example'), {
      created: Math.floor(Date.now() / 1000),
      nonce,
    })
    expect((await verifier.verify(request)).status).toBe('valid')
  }
})

test('claims nonces per agent, shared across verifiers on one store', async () => {
  const nonceStore = Store.memory()
  const other = key('22')
  const book = agentBook({
    [account.address.toLowerCase()]: humanId,
    [other.address.toLowerCase()]: 7n,
  })
  const a = verifierFor({ agentBook: book, nonceStore })
  const b = verifierFor({ agentBook: book, nonceStore })
  const first = await craft({ nonce: 'sharednonce1' })
  expect((await a.verify(first.clone())).status).toBe('valid')
  expect((await b.verify(first)).status).toBe('invalid')
  // The same nonce from another agent is a different claim.
  expect(await a.verify(await craft({ nonce: 'sharednonce1' }, { signer: other }))).toMatchObject({
    status: 'valid',
    value: { humanId: '0x7' },
  })
})

test('maps a nonce store failure to unavailable', async () => {
  const fail = async () => {
    throw new Error('store down')
  }
  const nonceStore = { ...Store.memory(), update: fail, tryClaim: fail } as never
  const verifier = verifierFor({ agentBook: registered(), nonceStore })
  expect(await verifier.verify(await craft())).toMatchObject({ status: 'unavailable' })
})

test('claims no nonce for an unregistered wallet', async () => {
  const claims: string[] = []
  const memory = Store.memory()
  const nonceStore = {
    ...memory,
    tryClaim: async (key: string, expires: number) => {
      claims.push(key)
      return Store.tryClaim(memory, key, expires)
    },
  } as never
  const verifier = verifierFor({ agentBook: agentBook({}), nonceStore })
  expect(await verifier.verify(await craft())).toMatchObject({ status: 'forbidden' })
  expect(claims).toHaveLength(0)
})

test('checks the signature before claiming the nonce or reading AgentBook', async () => {
  const book = registered()
  const verifier = verifierFor({ agentBook: book })
  const intruder = key('33')
  // Signed by another key for the registered address.
  const forged = await craft(
    { nonce: 'forgednonce1' },
    { signer: { ...intruder, address: account.address } as typeof account },
  )
  expect(await verifier.verify(forged)).toMatchObject({ status: 'invalid' })
  expect(book.calls).toHaveLength(0)
  // The forgery did not use up the agent's nonce.
  expect((await verifier.verify(await craft({ nonce: 'forgednonce1' }))).status).toBe('valid')
})

test('calls the chain only for an invalid signature typed eip1271', async () => {
  const calls: unknown[] = []
  const verifier = verifierFor({
    clients: {
      480: {
        async verifyMessage(parameters) {
          calls.push(parameters)
          return false
        },
      },
    },
  })
  expect((await verifier.verify(await craft())).status).toBe('valid')
  expect(calls).toHaveLength(0)
  // An invalid signature typed eip191 is rejected locally, without an RPC call.
  const bad = await craft({}, { signature: '0x' + '00'.repeat(65) })
  expect((await verifier.verify(bad)).status).toBe('invalid')
  expect(calls).toHaveLength(0)
  // Only a payload typed eip1271 falls back to the chain.
  const smart = await craft({ type: 'eip1271' }, { signature: '0x' + '00'.repeat(65) })
  expect((await verifier.verify(smart)).status).toBe('invalid')
  expect(calls).toHaveLength(1)
})

test('reads a custom AgentBook deployment', async () => {
  const book = registered()
  const address = '0x000000000000000000000000000000000000dEaD'
  const verifier = verifierFor({ agentBook: { ...book, address } })
  expect((await verifier.verify(await craft())).status).toBe('valid')
  expect(book.calls[0]).toMatchObject({ address, functionName: 'lookupHuman' })
  expect(await World.Server.agentBook({ client: agentBook({}).client })(account.address)).toBe(
    undefined,
  )
})

test('runs the full client flow: signs each attempt and binds the paid retry', async () => {
  const testMethod = Method.from({
    name: 'test',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
    },
  })
  const serverMethod = Method.toServer(testMethod, {
    async verify() {
      return Receipt.from({
        method: 'test',
        reference: 'r',
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
  const clientMethod = Method.toClient(testMethod, {
    async createCredential({ challenge }) {
      return Credential.serialize({ challenge, payload: { token: 'paid' } })
    },
  })
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  let human = verifierFor()
  const payloads: World.Payload[] = []
  const issued: string[] = []
  const listener = ServerRequest.toNodeListener(async (request) => {
    const header = request.headers.get('agentkit')
    if (header) payloads.push(JSON.parse(Base64.toString(header)))
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      recipient: 'merchant',
      identity: [human],
    })(request)
    if (result.status === 402) {
      if (result.challenge.status === 402) issued.push(Challenge.fromResponse(result.challenge).id)
      return result.challenge
    }
    return result.withReceipt(new Response(result.identity?.get(human)?.humanId))
  })
  const server = await Http.createServer(((request, response) =>
    listener(request, response)) as RequestListener)
  human = verifierFor({ origins: [server.url] })

  try {
    const client = ClientMppx.create({
      identity: [World.Client.prover({ account, scope: [server.url] })],
      methods: [clientMethod],
      polyfill: false,
    })
    const response = await client.fetch(server.url + '/report')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0x2a5')
    expect(payloads).toHaveLength(2)
    expect(payloads[0]!.requestId).toBeUndefined()
    expect(payloads[1]!.nonce).not.toBe(payloads[0]!.nonce)
    // The paid retry is signed over the Challenge it answers.
    expect(issued).toHaveLength(1)
    expect(payloads[1]!.requestId).toBe(issued[0])

    // Out of scope: no signature, so the route asks for one.
    const anonymous = ClientMppx.create({
      identity: [World.Client.prover({ account, scope: ['https://elsewhere.example'] })],
      methods: [clientMethod],
      polyfill: false,
    })
    expect((await anonymous.fetch(server.url)).status).toBe(401)

    const stranger = ClientMppx.create({
      identity: [World.Client.prover({ account: key('44'), scope: '*' })],
      methods: [clientMethod],
      polyfill: false,
    })
    const forbidden = await stranger.fetch(server.url)
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('Link')).toContain('rel="register"')
  } finally {
    server.close()
  }
})

test('verifies smart accounts on World Chain only unless configured', async () => {
  // A smart account typed eip1271 on Base, with no Base RPC configured, is rejected locally.
  const verifier = World.Server.verifier({
    ...base,
    agentBook: registered(),
    nonceStore: Store.memory(),
  })
  expect(
    await verifier.verify(
      await craft(
        { type: 'eip1271', chainId: 'eip155:8453' },
        { signature: '0x' + '00'.repeat(65) },
      ),
    ),
  ).toMatchObject({ status: 'invalid', reason: expect.stringContaining('signature') })
})

test('binds the message to its origins, never the Host header', async () => {
  // Signed for another site the agent talks to, then sent here with that site's Host.
  const elsewhere = await craft({}, { url: 'https://evil.example/api/report' })
  const pinned = verifierFor()
  expect(await pinned.verify(elsewhere)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('URI'),
  })
  expect((await pinned.verify(await craft())).status).toBe('valid')
  // The scheme is part of the origin.
  expect((await pinned.verify(await craft({}, { url: 'http://api.example/report' }))).status).toBe(
    'invalid',
  )
  expect((await pinned.verify(await craft({ domain: 'other.example' }))).status).toBe('invalid')
})

test('accepts only canonical chain IDs, version 1 and plain request IDs', async () => {
  const verifier = verifierFor()
  for (const overrides of [
    { chainId: 'eip155:0480' },
    { chainId: 'eip155:0' },
    { chainId: 'eip155:99999999999999999999999' },
    { version: '2' },
    { requestId: 'x\nResources:\n- https://z.example' },
    { requestId: 'has space' },
  ])
    expect(await verifier.verify(await craft(overrides))).toMatchObject({ status: 'invalid' })
})

test('returns the checksummed address whatever case was signed', async () => {
  const result = await verifierFor().verify(await craft({ address: account.address.toLowerCase() }))
  expect(result).toMatchObject({ status: 'valid', value: { address: account.address } })
})

test('shares AgentBook lookups for the same wallet', async () => {
  const book = registered()
  const verifier = verifierFor({ agentBook: book })
  const results = await Promise.all([1, 2, 3].map(async () => verifier.verify(await craft())))
  expect(results.map((result) => result.status)).toEqual(['valid', 'valid', 'valid'])
  expect(book.calls).toHaveLength(1)
  // An outage is not cached.
  const down = agentBook({}, { fail: true })
  const flaky = verifierFor({ agentBook: down })
  expect((await flaky.verify(await craft())).status).toBe('unavailable')
  expect((await flaky.verify(await craft())).status).toBe('unavailable')
  expect(down.calls).toHaveLength(2)
})

test('refreshes an expired registered wallet with one shared lookup', async () => {
  let registeredNow = true
  const calls: unknown[] = []
  const book = {
    client: {
      async readContract(parameters: unknown) {
        calls.push(parameters)
        return registeredNow ? humanId : 0n
      },
    },
  }
  const verifier = verifierFor({ agentBook: book })
  expect((await verifier.verify(await craft())).status).toBe('valid')
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
  try {
    registeredNow = false
    const results = await Promise.all(
      [1, 2, 3].map(async () =>
        verifier.verify(await craft({ issuedAt: new Date(now + 61_000).toISOString() })),
      ),
    )
    // One refresh, and its unregistered answer is not hidden by the expired entry.
    expect(calls).toHaveLength(2)
    expect(results.map((result) => result.status)).toEqual(['forbidden', 'forbidden', 'forbidden'])
  } finally {
    clock.mockRestore()
  }
})

test('tells a smart-account RPC outage from an invalid signature', async () => {
  const smart = (getChainId: () => Promise<number>) =>
    verifierFor({ clients: { 480: { verifyMessage: async () => false, getChainId } } })
  const proof = () => craft({ type: 'eip1271' }, { signature: '0x' + '00'.repeat(65) })
  expect((await smart(async () => 480).verify(await proof())).status).toBe('invalid')
  const down = smart(async () => {
    throw new Error('rpc down')
  })
  expect((await down.verify(await proof())).status).toBe('unavailable')
})

test('tells a default client RPC outage from a reverted signature check', async () => {
  let reply: (id: unknown) => { status: number; body: unknown } = () => ({ status: 500, body: '' })
  const server = await Http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const { id } = JSON.parse(raw)
      const { status, body } = reply(id)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  try {
    const verifier = verifierFor({ clients: {}, rpcUrl: server.url })
    const proof = () => craft({ type: 'eip1271' }, { signature: '0x' + '00'.repeat(65) })
    expect((await verifier.verify(await proof())).status).toBe('unavailable')
    reply = (id) => ({
      status: 200,
      body: { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } },
    })
    expect((await verifier.verify(await proof())).status).toBe('invalid')
  } finally {
    server.close()
  }
})

test('accepts one spelling of an address: lowercase or checksummed', async () => {
  const verifier = verifierFor()
  // Flipping one letter's case breaks the EIP-55 checksum.
  const index = account.address.slice(2).search(/[a-fA-F]/) + 2
  const letter = account.address[index]!
  const flipped =
    account.address.slice(0, index) +
    (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()) +
    account.address.slice(index + 1)
  expect(await verifier.verify(await craft({ address: flipped }))).toMatchObject({
    status: 'invalid',
  })
  expect(
    await verifier.verify(await craft({ address: account.address.toLowerCase() })),
  ).toMatchObject({ status: 'valid', value: { address: account.address } })
})

test('sends a request unsigned when its URL cannot be a SIWE message', async () => {
  const prover = World.Client.prover({ account, scope: '*' })
  for (const url of ['http://[::1]:8787/report', 'https://under_score.example/report']) {
    const request = await prover.prove(new Request(url), {
      created: Math.floor(Date.now() / 1000),
      nonce: 'unsigned-attempt',
    })
    expect(request.headers.has('agentkit')).toBe(false)
  }
})
