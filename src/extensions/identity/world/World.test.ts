import { Method, Receipt, Store, z } from 'mppx'
import * as World from 'mppx/extensions/identity/world'
import { Mppx } from 'mppx/server'
import { Base64 } from 'ox'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, test } from 'vp/test'

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
    reason: expect.stringContaining('domain'),
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
    clients: offline,
    agentBook: registered(),
    nonceStore: Store.memory(),
  })
  expect(await verifier.verify(stale)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('too old'),
  })

  const down = World.Server.verifier({
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
