import { Credential, Method, Receipt, Store, z } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import * as Erc8004 from 'mppx/extensions/identity/erc8004'
import * as Identity from 'mppx/identity'
import { Mppx } from 'mppx/server'
import {
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { expect, test } from 'vp/test'

const origin = 'https://api.example'
const url = `${origin}/haiku`
const registry = Erc8004.Constants.identityRegistry
const agentKey = privateKeyToAccount(generatePrivateKey())
const otherKey = privateKeyToAccount(generatePrivateKey())
const contractWallet = '0x3333333333333333333333333333333333333333'

const abi = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
])

/** A stand-in for the Identity Registry: agent 1's wallet is `agentKey`, agent 2 has none, agent 3 is a contract wallet. */
function createRegistry(options: { down?: boolean; erc1271?: boolean } = {}) {
  const wallets: Record<string, Address> = {
    '1': agentKey.address,
    '2': zeroAddress,
    '3': contractWallet,
  }
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1079'
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
        if (options.down) throw new Error('down')
        const [{ data, to }] = params as [{ data: `0x${string}`; to: Address }]
        const call = decodeFunctionData({ abi, data })
        if (call.functionName === 'getAgentWallet' && isAddressEqual(to, registry))
          return encodeFunctionResult({
            abi,
            functionName: 'getAgentWallet',
            result: wallets[String(call.args[0])] ?? zeroAddress,
          })
        if (
          call.functionName === 'isValidSignature' &&
          options.erc1271 &&
          isAddressEqual(to, contractWallet)
        )
          return encodeFunctionResult({
            abi,
            functionName: 'isValidSignature',
            result: '0x1626ba7e',
          })
        throw new Error('execution reverted')
      },
    }),
  })
}

const method = Method.from({
  name: 'tempo',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})
const serverMethod = Method.toServer(method, {
  async verify() {
    return Receipt.from({
      method: 'tempo',
      reference: 'ref',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
/** A client method that pays from `address`, as the tempo method names the payer. */
function payFrom(address: Address) {
  return Method.toClient(method, {
    async createCredential({ challenge }) {
      return Credential.serialize({
        challenge,
        payload: { token: 'paid' },
        source: `did:pkh:eip155:4217:${address}`,
      })
    },
  })
}

function setup(config: Partial<Erc8004.Server.create.Config> = {}) {
  const agents = Erc8004.Server.create({
    client: createRegistry(),
    store: Store.memory(),
    ...config,
  })
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'api.example',
    secretKey: 'test-secret-key-test-secret-key!',
  })
  const handler = async (request: Request) => {
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      identity: { request: [agents.verifier], payment: agents.paymentCheck },
      recipient: 'merchant',
    })(request)
    if (result.status !== 200) return result.challenge
    const agent = result.identity?.get(agents.paymentCheck)
    return result.withReceipt(Response.json({ ...agent, agentId: String(agent?.agentId) }))
  }
  return { agents, handler }
}

function client(
  handler: (request: Request) => Promise<Response>,
  options: { agentId?: bigint; signer?: typeof agentKey; payer?: Address } = {},
) {
  return ClientMppx.create({
    fetch: async (input, init) => handler(new Request(input, init)),
    identity: [
      Erc8004.Client.prover({
        account: options.signer ?? agentKey,
        agentId: options.agentId ?? 1n,
        scope: [origin],
      }),
    ],
    methods: [payFrom(options.payer ?? agentKey.address)],
    polyfill: false,
  })
}

test('an agent signs and pays from its registered wallet', async () => {
  const { handler } = setup()
  const response = await client(handler).fetch(url)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    agentId: '1',
    id: `eip155:4217:${registry}:1`,
    wallet: agentKey.address,
  })
})

test('rejects a request without an agent', async () => {
  const { handler } = setup()
  const response = await handler(new Request(url))
  expect(response.status).toBe(401)
})

test("rejects a signature from a key other than the agent's wallet", async () => {
  const { handler } = setup()
  const response = await client(handler, { signer: otherKey }).fetch(url)
  expect(response.status).toBe(401)
  expect(await response.text()).toContain("The agent's wallet did not sign the request.")
})

test("rejects a payment from an account other than the agent's wallet", async () => {
  const { handler } = setup()
  const response = await client(handler, { payer: otherKey.address }).fetch(url)
  expect(response.status).toBe(403)
  expect(await response.text()).toContain("The payment is not from the agent's wallet.")
})

test('rejects an agent without a wallet', async () => {
  const { handler } = setup()
  const response = await client(handler, { agentId: 2n }).fetch(url)
  expect(response.status).toBe(403)
})

test('rejects an agent in another registry', async () => {
  const { handler } = setup()
  const response = await handler(
    new Request(url, { headers: { 'Agent-Id': `eip155:1:${registry}:1` } }),
  )
  expect(response.status).toBe(401)
})

test('accepts an ERC-1271 wallet that approves the signature', async () => {
  const { handler } = setup({ client: createRegistry({ erc1271: true }) })
  const response = await client(handler, { agentId: 3n, payer: contractWallet }).fetch(url)
  expect(response.status).toBe(200)
})

test('rejects a replayed signature', async () => {
  const { handler } = setup()
  const sent: Request[] = []
  const agent = client(async (request) => {
    sent.push(request.clone())
    return handler(request)
  })
  await agent.fetch(url)
  const replay = await handler(sent[0]!)
  expect(replay.status).toBe(401)
  expect(await replay.text()).toContain('already used')
})

test('answers 503 when the registry is unavailable', async () => {
  const { handler } = setup({ client: createRegistry({ down: true }) })
  const response = await client(handler).fetch(url)
  expect(response.status).toBe(503)
})

test('allow decides by agent', async () => {
  const { handler } = setup({ allow: (agent) => agent.agentId !== 1n })
  const response = await client(handler).fetch(url)
  expect(response.status).toBe(403)
})

test('marks the agent headers as bearer identity headers, so a proxy does not forward them', () => {
  expect(Identity.Headers.request).toContain('agent-id')
  expect(Identity.Headers.request).toContain('agent-signature')
})
