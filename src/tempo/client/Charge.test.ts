import { Challenge, Credential } from 'mppx'
import { type Address, createClient, http, isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Account, Addresses, Secp256k1 } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as Methods from '../Methods.js'
import { mach } from '../Tokens.js'
import { charge } from './Charge.js'

const account = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const currency = '0x3333333333333333333333333333333333333333'
const recipient = '0x2222222222222222222222222222222222222222'

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.charge.schema.request.parse>[0]> = {},
): Challenge.Challenge<ChargeRequest, 'charge', 'tempo'> {
  const request = Methods.charge.schema.request.parse({
    amount: '0',
    currency,
    decimals: 6,
    recipient,
    ...overrides,
  })
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'charge',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<ChargeRequest, 'charge', 'tempo'>
}

function mockMachFeeSelection() {
  const getBalance = vi.fn(
    async (_client: unknown, parameters: { decimals?: number; token: Address }) => ({
      amount: isAddressEqual(parameters.token, Addresses.pathUsd) ? 1_000_000n : 0n,
    }),
  )
  const getUserToken = vi.fn(async () => ({ address: mach(42431).address }))

  vi.doMock('viem/tempo', async (importOriginal) => {
    const original = await importOriginal<typeof import('viem/tempo')>()
    return {
      ...original,
      Actions: {
        ...original.Actions,
        fee: { ...original.Actions.fee, getUserToken },
        token: { ...original.Actions.token, getBalance },
      },
    }
  })

  return { getBalance, getUserToken }
}

describe('tempo.charge client', () => {
  test('prioritizes a funded charge currency over an unfunded one', async () => {
    vi.resetModules()
    const { getBalance } = mockMachFeeSelection()

    try {
      const { charge: chargeWithMockedBalance } = await import('./Charge.js')
      const chainId = 42431
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedBalance({ account, getClient: () => client })

      await expect(
        method.getChallengePriority?.({
          challenge: createChallenge({
            amount: '1',
            chainId,
            currency: Addresses.pathUsd,
          }),
        }),
      ).resolves.toBe(1)
      await expect(
        method.getChallengePriority?.({
          challenge: createChallenge({
            amount: '1',
            chainId,
            currency: mach(chainId).address,
          }),
        }),
      ).resolves.toBe(-1)
      expect(getBalance).toHaveBeenCalledTimes(2)
      expect(getBalance.mock.calls.every(([, parameters]) => parameters.decimals === 0)).toBe(true)
    } finally {
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })

  test('uses client chain ID when the challenge omits chainId', async () => {
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: () => client,
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge(),
        context: {},
      }),
    )

    expect(credential.source).toBe(`did:pkh:eip155:${tempoLocalnet.id}:${account.address}`)
  })

  test('uses challenge chainId for client resolution and proof source', async () => {
    let requestedChainId: number | undefined
    const chainId = 42431
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: (parameters) => {
        requestedChainId = parameters.chainId
        return client
      },
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge({ chainId }),
        context: {},
      }),
    )

    expect(requestedChainId).toBe(chainId)
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('passes the client to viem 2.54 Tempo transfer call builders', async () => {
    vi.resetModules()
    const chainId = 42431
    const transferCalls: { client: unknown; parameters: Record<string, unknown> }[] = []
    function transferCall(client: unknown, parameters: Record<string, unknown>) {
      transferCalls.push({ client, parameters })
      return { data: '0x', to: parameters.token }
    }
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))
    vi.doMock('viem/tempo', async (importOriginal) => {
      const original = await importOriginal<typeof import('viem/tempo')>()
      return {
        ...original,
        Actions: {
          ...original.Actions,
          token: { ...original.Actions.token, transfer: { call: transferCall } },
        },
      }
    })

    try {
      const { charge: chargeWithMockedTempo } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedTempo({
        account,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ amount: '1', chainId, supportedModes: ['pull'] }),
          context: {},
        }),
      )

      expect(transferCalls).toHaveLength(1)
      expect(transferCalls[0]!.client).toBe(client)
      expect(transferCalls[0]!.parameters).toMatchObject({
        amount: 1_000_000n,
        to: recipient,
        token: currency,
      })
      expect(prepareTransactionRequest).toHaveBeenCalledOnce()
      expect(signTransaction).toHaveBeenCalledOnce()
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })

  test('uses a stablecoin fee token for unsponsored MACH pull charges', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 42431
    const prepareTransactionRequest = vi.fn(async (_client: unknown, parameters: object) => ({
      ...parameters,
      gas: 100n,
    }))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      sendTransactionSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
      })

      await method.createCredential({
        challenge: createChallenge({
          amount: '1',
          chainId,
          currency: mach(chainId).address,
          supportedModes: ['pull'],
        }),
        context: {},
      })

      expect(prepareTransactionRequest).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ feeToken: Addresses.pathUsd }),
      )
      expect(signTransaction).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ feeToken: Addresses.pathUsd }),
      )
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })

  test('uses a stablecoin fee token for local and JSON-RPC MACH push charges', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 42431
    const hash = `0x${'ab'.repeat(32)}`
    const sendCallsSync = vi.fn(async () => ({ receipts: [{ transactionHash: hash }] }))
    const sendTransactionSync = vi.fn(async () => ({ transactionHash: hash }))
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync,
      sendTransactionSync,
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const localClient = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const rpcClient = createClient({
        account: account.address,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const challenge = createChallenge({
        amount: '1',
        chainId,
        currency: mach(chainId).address,
        supportedModes: ['push'],
      })

      await chargeWithMockedActions({
        account,
        getClient: () => localClient,
      }).createCredential({ challenge, context: {} })
      await chargeWithMockedActions({
        account: account.address,
        getClient: () => rpcClient,
      }).createCredential({ challenge, context: {} })

      expect(sendTransactionSync).toHaveBeenCalledWith(
        localClient,
        expect.objectContaining({ feeToken: Addresses.pathUsd }),
      )
      expect(sendCallsSync).toHaveBeenCalledWith(
        rpcClient,
        expect.objectContaining({ capabilities: { feeToken: Addresses.pathUsd } }),
      )
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })

  test('resolveAccount selects the transaction account from executable calls', async () => {
    vi.resetModules()
    const selectedAccount = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    )
    const chainId = 42431
    const calls: charge.ResolveAccountInfo[] = []
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
        resolveAccount(info) {
          calls.push(info)
          return selectedAccount
        },
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ amount: '1', chainId, supportedModes: ['pull'] }),
          context: {},
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]!.account.address).toBe(account.address)
      expect(calls[0]!.chainId).toBe(chainId)
      expect(calls[0]!.operation.kind).toBe('executeCalls')
      if (calls[0]!.operation.kind !== 'executeCalls') throw new Error('expected executeCalls')
      expect(calls[0]!.operation.calls).toHaveLength(1)
      expect(calls[0]!.operation.calls?.[0]?.to.toLowerCase()).toBe(currency.toLowerCase())
      expect(prepareTransactionRequest).toHaveBeenCalledOnce()
      expect(signTransaction).toHaveBeenCalledOnce()
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${selectedAccount.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('resolveAccount omits executable calls when auto-swap routing is account-dependent', async () => {
    vi.resetModules()
    const selectedAccount = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    )
    const chainId = 42431
    const calls: charge.ResolveAccountInfo[] = []
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    const findCalls = vi.fn(async (_client: unknown, _parameters: { account: string }) => undefined)
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/auto-swap.js', () => ({
      defaultCurrencies: [currency],
      findCalls,
      resolve: vi.fn(() => ({ tokenIn: [currency], slippage: 1 })),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        autoSwap: true,
        getClient: () => client,
        resolveAccount(info) {
          calls.push(info)
          return selectedAccount
        },
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ amount: '1', chainId, supportedModes: ['pull'] }),
          context: {},
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]!.operation.kind).toBe('executeCalls')
      if (calls[0]!.operation.kind !== 'executeCalls') throw new Error('expected executeCalls')
      expect(calls[0]!.operation.calls).toBeUndefined()
      expect(findCalls).toHaveBeenCalledOnce()
      expect(findCalls.mock.calls[0]?.[1].account).toBe(selectedAccount.address)
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('../internal/auto-swap.js')
      vi.resetModules()
    }
  })

  test('broadcasts local split payments as one Tempo transaction in push mode', async () => {
    vi.resetModules()
    const chainId = 42431
    const hash = `0x${'ab'.repeat(32)}`
    const sendCallsSync = vi.fn()
    const sendTransactionSync = vi.fn(async () => ({ transactionHash: hash }))
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync,
      sendTransactionSync,
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
        mode: 'push',
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({
            amount: '1',
            chainId,
            splits: [
              {
                amount: '0.25',
                recipient: '0x4444444444444444444444444444444444444444',
              },
            ],
            supportedModes: ['push'],
          }),
          context: {},
        }),
      )

      expect(sendTransactionSync).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          account,
          calls: expect.arrayContaining([
            expect.objectContaining({ to: currency }),
            expect.objectContaining({ to: currency }),
          ]),
          nonceKey: 'expiring',
        }),
      )
      expect(sendCallsSync).not.toHaveBeenCalled()
      expect(credential.payload).toEqual({ hash, type: 'hash' })
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('zero-amount proof binds to the root payer for an access-key account', async () => {
    vi.resetModules()
    // Capture the typed data so we can assert what the proof commits to.
    let signedTypedData: { message: { account: string } } | undefined
    const signTypedData = vi.fn(async (_client: unknown, parameters: typeof signedTypedData) => {
      signedTypedData = parameters
      return '0xdeadbeef'
    })
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData,
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const chainId = 42431
      // An access-key account signs with its own key but reports the root
      // account as `address`; the proof must bind to that root payer.
      const accessKey = Account.fromSecp256k1(Secp256k1.randomPrivateKey(), {
        access: account,
      })
      expect(accessKey.address).toBe(account.address)
      expect(accessKey.accessKeyAddress).not.toBe(account.address)

      const client = createClient({
        account: accessKey,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const resolveAccount = vi.fn()
      const method = chargeWithMockedActions({
        account: accessKey,
        getClient: () => client,
        resolveAccount,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(signTypedData).toHaveBeenCalledOnce()
      expect(resolveAccount).not.toHaveBeenCalled()
      expect(signedTypedData?.message.account).toBe(account.address)
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'proof' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('uses challenge chainId for non-zero transaction source', async () => {
    vi.resetModules()
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const chainId = 42431
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ amount: '1', chainId, supportedModes: ['pull'] }),
          context: {},
        }),
      )

      expect(prepareTransactionRequest).toHaveBeenCalledOnce()
      expect(signTransaction).toHaveBeenCalledOnce()
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test('normalizes sponsored pull transactions before signing', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const prepared = {
      feePayerSignature: { r: '0x1', s: '0x2', yParity: 0 },
      feeToken: Addresses.pathUsd,
      gas: 100n,
    }
    const prepareTransactionRequest = vi.fn(async () => prepared)
    const signTransaction = vi.fn(
      async (_client: unknown, _transaction: Record<string, unknown>) => '0xdeadbeef',
    )
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const chainId = 42431
      const client = createClient({
        account,
        chain: tempoLocalnet,
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({
        account,
        getClient: () => client,
      })

      await method.createCredential({
        challenge: createChallenge({
          amount: '1',
          chainId,
          currency: mach(chainId).address,
          feePayer: true,
          supportedModes: ['pull'],
        }),
        context: {},
      })

      expect(prepareTransactionRequest).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          feeToken: Addresses.pathUsd,
        }),
      )
      expect(signTransaction).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          feePayer: true,
          gas: 5_100n,
        }),
      )
      const signed = signTransaction.mock.calls[0]?.[1] as Record<string, unknown>
      expect(signed).not.toHaveProperty('feePayerSignature')
      expect(signed).not.toHaveProperty('feeToken')
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.resetModules()
    }
  })

  describe('chain pinning', () => {
    const client = createClient({
      account,
      chain: tempoLocalnet,
      transport: http('http://127.0.0.1'),
    })

    test('rejects a challenge whose chainId conflicts with the pin', async () => {
      const getClient = vi.fn(() => client)
      const method = charge({
        account,
        expectedChainId: 42431,
        getClient,
      })

      await expect(
        method.createCredential({
          challenge: createChallenge({ chainId: 1 }),
          context: {},
        }),
      ).rejects.toThrow('Chain ID mismatch: expected 42431, got 1.')

      // The mismatch is rejected before resolving a client or signing.
      expect(getClient).not.toHaveBeenCalled()
    })

    test('accepts a challenge whose chainId matches the pin', async () => {
      const chainId = 42431
      const method = charge({
        account,
        expectedChainId: chainId,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })

    test('signs on the pin when the challenge omits chainId', async () => {
      let requestedChainId: number | undefined
      const chainId = 42431
      const method = charge({
        account,
        expectedChainId: chainId,
        getClient: (parameters) => {
          requestedChainId = parameters.chainId
          return client
        },
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge(),
          context: {},
        }),
      )

      expect(requestedChainId).toBe(chainId)
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })

    test('unpinned client accepts any challenge chainId', async () => {
      const chainId = 1
      const method = charge({
        account,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({ chainId }),
          context: {},
        }),
      )

      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    })
  })
})
