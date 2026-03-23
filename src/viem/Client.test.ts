import { createClient, custom, defineChain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTransaction } from 'viem/actions'
import { tempoLocalnet } from 'viem/chains'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vitest'

import * as Client from './Client.js'

const rpcUrl = { 42: 'https://rpc.example.com', 99: 'https://rpc2.example.com' } as const

describe('getResolver', () => {
  test('behavior: creates client from rpcUrl for given chainId', async () => {
    const getClient = Client.getResolver({
      rpcUrl,
    })

    const client = await getClient({ chainId: 42 })

    expect(client).toBeDefined()
    expect(client.chain?.id).toBe(42)
  })

  test('behavior: falls back to first rpcUrl key when chainId is 0', async () => {
    const getClient = Client.getResolver({
      rpcUrl,
    })

    const client = await getClient({})

    expect(client.chain?.id).toBe(42)
  })

  test('behavior: spreads chain into created client', async () => {
    const chain = { id: 1, name: 'test' }
    const getClient = Client.getResolver({
      chain: chain as never,
      rpcUrl,
    })

    const client = await getClient({ chainId: 99 })

    expect(client.chain?.id).toBe(99)
    expect(client.chain?.name).toBe('test')
  })

  test('error: throws when no rpcUrl provided', () => {
    const getClient = Client.getResolver({})

    expect(() => getClient({ chainId: 1 })).toThrowErrorMatchingInlineSnapshot(
      `[Error: No \`rpcUrl\` provided.]`,
    )
  })

  test('error: throws when chainId not found in rpcUrl', () => {
    const getClient = Client.getResolver({
      rpcUrl: { 42: 'https://example.com' },
    })

    expect(() => getClient({ chainId: 99 })).toThrowErrorMatchingInlineSnapshot(
      `[Error: No \`rpcUrl\` configured for \`chainId\` (99).]`,
    )
  })
})

// ---------------------------------------------------------------------------
// Serializer injection – ensures user-provided clients without Tempo chain
// config get Tempo serializers merged in by getResolver.
// ---------------------------------------------------------------------------

const testAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const chainIdHex = `0x${tempoLocalnet.id.toString(16)}`
const mockTransport = custom({
  async request({ method }: { method: string }) {
    if (method === 'eth_chainId') return chainIdHex
    throw new Error(`Unexpected RPC call: ${method}`)
  },
})

const tempoClient = createClient({
  account: testAccount,
  chain: tempoLocalnet,
  transport: mockTransport,
})

function createPlainClient() {
  const plainChain = defineChain({
    id: tempoLocalnet.id,
    name: 'Tempo (no serializer)',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://127.0.0.1:1'] } },
  })
  return createClient({
    account: testAccount,
    chain: plainChain,
    transport: mockTransport,
  })
}

const feePayer_prepared = {
  chainId: tempoLocalnet.id,
  calls: [
    {
      to: '0x20c0000000000000000000000000000000000001' as const,
      data: '0x1234' as Hex,
    },
  ],
  feePayer: true as const,
  feeToken: '0x20c0000000000000000000000000000000000001' as const,
  gas: 100_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  nonce: 0,
  nonceKey: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
  validBefore: Math.floor(Date.now() / 1000) + 25,
}

describe('feePayer transaction serialization', () => {
  test('behavior: signTransaction with Tempo chain and feePayer: true', async () => {
    const serialized = await signTransaction(tempoClient, {
      account: testAccount,
      ...feePayer_prepared,
    } as never)
    expect(serialized).toMatch(/^0x7[68]/)
  })

  test('behavior: signTransaction with gasPrice + type legacy', async () => {
    const serialized = await signTransaction(tempoClient, {
      account: testAccount,
      ...feePayer_prepared,
      gasPrice: 1_000_000_000n,
      type: 'legacy' as const,
    } as never)
    expect(serialized).toMatch(/^0x7[68]/)
  })

  test('behavior: fee-payer co-sign with Account object', async () => {
    const feePayerAccount = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const serialized = await signTransaction(tempoClient, {
      account: feePayerAccount,
      ...feePayer_prepared,
      feePayer: feePayerAccount,
    } as never)
    expect(serialized).toMatch(/^0x7[68]/)
  })

  test('behavior: deserialized + re-signed tx (server charge flow)', async () => {
    const feePayerAccount = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const clientSigned = await signTransaction(tempoClient, {
      account: testAccount,
      ...feePayer_prepared,
    } as never)
    const deserialized = Transaction.deserialize(
      clientSigned as Transaction.TransactionSerializedTempo,
    )
    const serverSigned = await signTransaction(tempoClient, {
      ...deserialized,
      account: feePayerAccount,
      feePayer: feePayerAccount,
      feeToken: '0x20c0000000000000000000000000000000000001' as const,
    } as never)
    expect(serverSigned).toMatch(/^0x7[68]/)
  })
})

describe('getResolver serializer injection', () => {
  test('behavior: injects Tempo serializer onto plain clients', async () => {
    const plainClient = createPlainClient()
    expect(plainClient.chain?.serializers?.transaction).toBeUndefined()

    const resolver = Client.getResolver({
      chain: tempoLocalnet,
      getClient: () => plainClient,
    })
    const resolvedClient = await resolver({})

    expect(resolvedClient.chain?.serializers?.transaction).toBeDefined()
    const serialized = await signTransaction(resolvedClient, {
      account: testAccount,
      ...feePayer_prepared,
    } as never)
    expect(serialized).toMatch(/^0x7[68]/)
  })

  test('behavior: fixes legacy type + feePayer + maxFeePerGas', async () => {
    const resolver = Client.getResolver({
      chain: tempoLocalnet,
      getClient: () => createPlainClient(),
    })
    const resolvedClient = await resolver({})

    const serialized = await signTransaction(resolvedClient, {
      account: testAccount,
      ...feePayer_prepared,
      type: 'legacy' as const,
    } as never)
    expect(serialized).toMatch(/^0x7[68]/)
  })

  test('behavior: preserves existing serializers', async () => {
    const resolver = Client.getResolver({
      chain: tempoLocalnet,
      getClient: () => tempoClient,
    })
    const resolvedClient = await resolver({})

    expect(resolvedClient.chain?.serializers?.transaction).toBe(
      tempoClient.chain?.serializers?.transaction,
    )
  })

  test('behavior: passes through getClient when chain has no serializers', async () => {
    const getClient = () => createPlainClient()
    const resolver = Client.getResolver({
      chain: undefined,
      getClient,
    })

    expect(resolver).toBe(getClient)
  })

  test('behavior: does not mutate the original client', async () => {
    const plainClient = createPlainClient()
    const originalChain = plainClient.chain

    const resolver = Client.getResolver({
      chain: tempoLocalnet,
      getClient: () => plainClient,
    })
    const resolvedClient = await resolver({})

    expect(plainClient.chain).toBe(originalChain)
    expect(resolvedClient).not.toBe(plainClient)
    expect(resolvedClient.chain?.serializers?.transaction).toBeDefined()
  })

  test('error: plain client without resolver throws on feePayer tx', async () => {
    const plainClient = createPlainClient()

    await expect(
      signTransaction(plainClient, {
        account: testAccount,
        ...feePayer_prepared,
        type: 'legacy' as const,
      } as never),
    ).rejects.toThrow()
  })
})
