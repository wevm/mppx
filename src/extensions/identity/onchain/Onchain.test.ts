import { Challenge, Credential } from 'mppx'
import { evm as clientEvm, Mppx as ClientMppx } from 'mppx/client'
import * as Onchain from 'mppx/extensions/identity/onchain'
import { evm, Mppx } from 'mppx/server'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, tempo } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const other = privateKeyToAccount(
  '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
)
const registryAddress = '0x00000000000000000000000000000000000000AA'
const recipient = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'

const registryAbi = parseAbi(['function isVerified(address account) view returns (bool)'])
const indexerAbi = parseAbi([
  'function getAttestationUid(address recipient, bytes32 schema) view returns (bytes32)',
])
const easAbi = parseAbi([
  'struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }',
  'function getAttestation(bytes32 uid) view returns (Attestation)',
])

/** A client whose `eth_call`s are answered by `call`, which records each callee. */
function mockClient(chain: typeof base | typeof tempo, call: (to: Address, data: Hex) => Hex) {
  const calls: Address[] = []
  const client = createClient({
    chain,
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
        const [{ to, data }] = params as [{ to: Address; data: Hex }]
        calls.push(to)
        return call(to, data)
      },
    }),
  })
  return { calls, client }
}

/** A registry that allows the addresses in `allowed`. */
function allowlist(allowed: readonly Address[]) {
  return mockClient(tempo, (to, data) => {
    expect(to.toLowerCase()).toBe(registryAddress.toLowerCase())
    const { args } = decodeFunctionData({ abi: registryAbi, data })
    const [address] = args
    return encodeFunctionResult({
      abi: registryAbi,
      functionName: 'isVerified',
      result: allowed.some((a) => a.toLowerCase() === address.toLowerCase()),
    })
  })
}

/** Pays a route guarded by `check` with an EVM Credential, optionally tampered with. */
async function pay(
  check: ReturnType<typeof Onchain.Server.registry>,
  tamper?: (credential: Credential.Credential) => Credential.Credential,
) {
  const settlements: unknown[] = []
  const server = Mppx.create({
    methods: [
      evm.charge({
        currency: evm.assets.base.USDC,
        recipient,
        x402: {
          facilitator: {
            verify: async () => ({ isValid: true }),
            async settle(paymentPayload) {
              settlements.push(paymentPayload)
              return { success: true, transaction: `0x${'1'.repeat(64)}`, network: 'eip155:8453' }
            },
          },
        },
      }),
    ],
    realm: 'example.test',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const route = server.charge({ amount: '0.25', identity: { payment: check } })
  const request = new Request('https://example.test/paid')
  const offered = await route(request)
  if (offered.status !== 402) throw new Error('expected a 402')
  const client = ClientMppx.create({
    methods: [
      clientEvm.charge({ account, currencies: [clientEvm.assets.base.USDC], networks: [8453] }),
    ],
    polyfill: false,
  })
  const prepared = await client.preparePayment(offered.challenge)
  let header = await prepared.createCredential()
  if (tamper) header = Credential.serialize(tamper(Credential.deserialize(header)))
  const result = await route(new Request(request, { headers: { Authorization: header } }))
  return { offered: offered.challenge, result, settlements }
}

describe('registry', () => {
  test('advertises the registry in every 402', async () => {
    const { client } = allowlist([account.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    expect(check.requires).toEqual([
      { type: 'kyc', issuer: `eip155:${tempo.id}:${registryAddress}` },
    ])
    const { offered } = await pay(check)
    expect(offered.headers.get('Identity-Required')).toContain(
      `kyc;issuer="eip155:${tempo.id}:${registryAddress}"`,
    )
  })

  test('settles a payer the registry allows and exposes it to the handler', async () => {
    const { calls, client } = allowlist([account.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const { result, settlements } = await pay(check)
    expect(result.status).toBe(200)
    expect(settlements).toHaveLength(1)
    expect(calls).toHaveLength(1)
    if (result.status !== 200) throw new Error()
    expect(result.identity?.get(check)).toEqual({
      address: account.address,
      chainId: tempo.id,
      registry: registryAddress,
    })
  })

  test('forbids a payer the registry does not allow, before settlement', async () => {
    const { client } = allowlist([other.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const { result, settlements } = await pay(check)
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.challenge.status).toBe(403)
    expect(result.rejection).toMatchObject({
      stage: 'payment',
      status: 'forbidden',
      reason: 'The payer is not in the registry.',
    })
    expect(settlements).toEqual([])
  })

  test('does not settle a Credential that claims an allowed address it does not control', async () => {
    // `other` is allowed, but `account` signs the payment and claims to be `other`.
    const { client } = allowlist([other.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const { result, settlements } = await pay(check, (credential) => ({
      ...credential,
      source: `did:pkh:eip155:8453:${other.address}`,
    }))
    expect(result.status).not.toBe(200)
    expect(settlements).toEqual([])
  })

  test('rejects a Credential without a payer address', async () => {
    const { calls, client } = allowlist([account.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const { result, settlements } = await pay(check, ({ challenge, payload }) => ({
      challenge,
      payload,
    }))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.rejection).toMatchObject({ status: 'invalid' })
    expect(calls).toEqual([])
    expect(settlements).toEqual([])
  })

  test.each([
    ['a Stripe charge', 'stripe', { spt: 'spt_x' }],
    ['a Tempo Zone withdrawal', 'tempo', { type: 'zone', zoneId: 1, hash: '0x00' }],
    ['a Tempo push payment, already broadcast', 'tempo', { type: 'hash', hash: '0x00' }],
  ] as const)('rejects %s, which does not bind the payer address', async (_, method, payload) => {
    const { calls, client } = allowlist([account.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const challenge = Challenge.from({
      id: 'x',
      intent: 'charge',
      method,
      realm: 'example.test',
      request: {},
    } as never)
    const result = await check.verify({
      challenge,
      credential: { challenge, payload, source: `did:pkh:eip155:8453:${account.address}` },
      request: new Request('https://example.test'),
    })
    expect(result).toMatchObject({ status: 'invalid' })
    expect(calls).toEqual([])
  })

  test('rejects with 503 when the registry cannot be read, without leaking the error', async () => {
    const { client } = mockClient(tempo, () => {
      throw new Error('upstream secret detail')
    })
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const { result, settlements } = await pay(check)
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.challenge.status).toBe(503)
    expect(result.rejection?.reason).toBe('The registry could not be read.')
    expect(await result.challenge.text()).not.toContain('secret')
    expect(settlements).toEqual([])
  })

  test('uses a custom read and requirement type', async () => {
    const seen: Address[] = []
    const { client } = allowlist([])
    const check = Onchain.Server.registry({
      client,
      registry: registryAddress,
      type: 'accredited',
      read({ payer }) {
        seen.push(payer)
        return true
      },
    })
    expect(check.requires[0]?.type).toBe('accredited')
    const { result } = await pay(check)
    expect(result.status).toBe(200)
    expect(seen).toEqual([account.address])
  })

  test('requires a client with a chain', () => {
    const client = createClient({ transport: custom({ request: async () => null }) })
    expect(() => Onchain.Server.registry({ client, registry: registryAddress })).toThrow(
      'The registry client must have a chain.',
    )
  })

  test('is missing without a Credential', async () => {
    const { client } = allowlist([account.address])
    const check = Onchain.Server.registry({ client, registry: registryAddress })
    const challenge = Challenge.from({
      id: 'x',
      intent: 'charge',
      method: 'evm',
      realm: 'example.test',
      request: {},
    } as never)
    expect(
      await check.verify({ challenge, request: new Request('https://example.test') }),
    ).toMatchObject({ status: 'missing' })
  })
})

describe('coinbase', () => {
  const { attester, eas, indexer, schemas } = Onchain.Constants.coinbase
  const uid = `0x${'ab'.repeat(32)}` as const

  function attestations(
    overrides: Partial<{
      uid: Hex
      attester: Address
      recipient: Address
      expirationTime: bigint
      revocationTime: bigint
      schema: Hex
    }> = {},
  ) {
    return mockClient(base, (to, data) => {
      if (to.toLowerCase() === indexer.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: indexerAbi, data })
        expect(args[1]).toBe(schemas.verifiedAccount)
        return encodeFunctionResult({
          abi: indexerAbi,
          functionName: 'getAttestationUid',
          result: overrides.uid ?? uid,
        })
      }
      expect(to.toLowerCase()).toBe(eas.toLowerCase())
      return encodeFunctionResult({
        abi: easAbi,
        functionName: 'getAttestation',
        result: {
          uid,
          schema: overrides.schema ?? schemas.verifiedAccount,
          time: 1n,
          expirationTime: overrides.expirationTime ?? 0n,
          revocationTime: overrides.revocationTime ?? 0n,
          refUID: zeroHash,
          recipient: overrides.recipient ?? account.address,
          attester: overrides.attester ?? attester,
          revocable: true,
          data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        },
      })
    })
  }

  test('settles a payer with a live Verified Account attestation', async () => {
    const { client } = attestations()
    const check = Onchain.Server.coinbase({ client })
    expect(check.requires).toEqual([{ type: 'kyc', issuer: `eip155:8453:${indexer}` }])
    const { result, settlements } = await pay(check)
    expect(result.status).toBe(200)
    expect(settlements).toHaveLength(1)
    if (result.status !== 200) throw new Error()
    expect(result.identity?.get(check)).toEqual({
      address: account.address,
      attestation: uid,
      chainId: 8453,
      registry: indexer,
    })
  })

  test.each([
    ['no attestation', { uid: zeroHash }],
    ['a revoked attestation', { revocationTime: 1n }],
    ['an expired attestation', { expirationTime: 1n }],
    ['another attester', { attester: other.address }],
    ['another recipient', { recipient: other.address }],
    ['another schema', { schema: schemas.verifiedCoinbaseOne }],
  ] as const)('forbids %s', async (_, overrides) => {
    const { client } = attestations(overrides)
    const { result, settlements } = await pay(Onchain.Server.coinbase({ client }))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(result.rejection?.status).toBe('forbidden')
    expect(settlements).toEqual([])
  })
})
