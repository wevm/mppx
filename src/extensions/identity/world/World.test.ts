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
  const verifier = World.Server.verifier({ agentBook: book, nonceStore: Store.memory() })
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
  const verifier = World.Server.verifier({ agentBook: agentBook({}), nonceStore })
  expect(await verifier.verify(new Request('https://api.example'))).toMatchObject({
    status: 'missing',
  })

  const unregistered = await verifier.verify(await signed())
  expect(unregistered).toMatchObject({ status: 'forbidden' })
  expect(unregistered.status === 'forbidden' && unregistered.reason).toContain(
    'agentkit-cli register',
  )

  const once = World.Server.verifier({ agentBook: registered(), nonceStore: Store.memory() })
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
  const verifier = World.Server.verifier({ agentBook: registered(), nonceStore: Store.memory() })
  expect(await verifier.verify(stale)).toMatchObject({
    status: 'invalid',
    reason: expect.stringContaining('too old'),
  })

  const down = World.Server.verifier({
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
  const human = World.Server.verifier({ agentBook: registered(), nonceStore: Store.memory() })
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
