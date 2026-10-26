import { Challenge, Credential } from 'mppx'
import { Mppx } from 'mppx/client'
import { TxEnvelopeTempo } from 'ox/tempo'
import { type Address, createClient, http, isAddressEqual, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Account, Addresses, Secp256k1 } from 'viem/tempo'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as MethodResponse from '../../client/internal/MethodResponse.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import { charge } from './Charge.js'

const account = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const currency = '0x3333333333333333333333333333333333333333'
const recipient = '0x2222222222222222222222222222222222222222'
const otherCurrency = '0x4444444444444444444444444444444444444444'

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
  const getBalance = vi.fn(async (_client: unknown, parameters: { token: Address }) => ({
    amount: isAddressEqual(parameters.token, Addresses.pathUsd) ? 1n : 0n,
  }))
  const getUserToken = vi.fn(async () => ({ address: defaults.machineToken[42431].token }))

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
  test('keeps legacy direct MACH challenges payable with a stablecoin fee token', async () => {
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
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({ account, getClient: () => client })

      await method.createCredential({
        challenge: createChallenge({
          amount: '1',
          chainId,
          currency: defaults.machineToken[chainId].token,
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
      chain: { ...tempoLocalnet, id: 42431 },
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
        chain: { ...tempoLocalnet, id: 42431 },
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

  test('uses a stablecoin fee token for unsponsored machine-token pull charges', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 42431
    const machineTokenCalls = [
      { data: '0x1234', to: '0x4444444444444444444444444444444444444444' },
      { data: '0x5678', to: '0x5555555555555555555555555555555555555555' },
    ]
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
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute: vi.fn(async () => ({ calls: machineTokenCalls })),
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
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
          machineTokenEnabled: true,
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
      vi.doUnmock('../internal/machine-token-charge.js')
      vi.resetModules()
    }
  })

  test('uses a stablecoin fee token for unsponsored machine-token push charges', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 42431
    const hash = `0x${'ab'.repeat(32)}`
    const machineTokenCalls = [
      { data: '0x1234', to: '0x4444444444444444444444444444444444444444' },
      { data: '0x5678', to: '0x5555555555555555555555555555555555555555' },
    ]
    const sendCallsSync = vi.fn(async () => ({ receipts: [{ transactionHash: hash }] }))
    const sendTransactionSync = vi.fn(async () => ({ transactionHash: hash }))
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync,
      sendTransactionSync,
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute: vi.fn(async () => ({ calls: machineTokenCalls })),
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const localClient = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const rpcClient = createClient({
        account: account.address,
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const challenge = createChallenge({
        amount: '1',
        chainId,
        machineTokenEnabled: true,
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
      vi.doUnmock('../internal/machine-token-charge.js')
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
        chain: { ...tempoLocalnet, id: 42431 },
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
        chain: { ...tempoLocalnet, id: 42431 },
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

  test('tries the enabled machine token before direct balance and auto-swap', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 42431
    const machineTokenCalls = [{ data: '0x1234', to: '0x4444444444444444444444444444444444444444' }]
    const autoSwapCalls = [{ data: '0x5678', to: '0x5555555555555555555555555555555555555555' }]
    let hasMachineTokens = true
    const findMachineTokenRoute = vi.fn(async (_client: unknown, _parameters: unknown) =>
      hasMachineTokens ? { calls: machineTokenCalls } : undefined,
    )
    const findAutoSwapCalls = vi.fn(async () => autoSwapCalls)
    const prepareTransactionRequest = vi.fn(
      async (_client: unknown, _parameters: { calls: readonly unknown[] }) => ({}),
    )
    const signTransaction = vi.fn(
      async (_client: unknown, _parameters: Record<string, unknown>) => '0xdeadbeef',
    )
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute: findMachineTokenRoute,
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))
    vi.doMock('../internal/auto-swap.js', () => ({
      defaultCurrencies: [currency],
      findCalls: findAutoSwapCalls,
      resolve: vi.fn(() => ({ tokenIn: [currency], slippage: 1 })),
    }))

    try {
      const { charge: chargeWithMockedFunding } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedFunding({
        account,
        autoSwap: true,
        getClient: () => client,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({
            amount: '1',
            chainId,
            feePayer: true,
            machineTokenEnabled: true,
            supportedModes: ['pull', 'push'],
          }),
          context: {},
        }),
      )

      expect(findMachineTokenRoute).toHaveBeenCalledOnce()
      expect(findMachineTokenRoute.mock.calls[0]?.[1]).toMatchObject({
        account: account.address,
        chainId,
        currency,
      })
      expect(findAutoSwapCalls).not.toHaveBeenCalled()
      expect(prepareTransactionRequest.mock.calls[0]?.[1]).toMatchObject({
        calls: machineTokenCalls,
        feeToken: Addresses.pathUsd,
      })
      expect(signTransaction).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ feePayer: true }),
      )
      expect(signTransaction.mock.calls[0]?.[1]).not.toHaveProperty('feeToken')
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'transaction' })

      hasMachineTokens = false
      await method.createCredential({
        challenge: createChallenge({
          amount: '1',
          chainId,
          feePayer: true,
          machineTokenEnabled: true,
          supportedModes: ['pull', 'push'],
        }),
        context: {},
      })
      expect(findAutoSwapCalls).toHaveBeenCalledOnce()
      expect(prepareTransactionRequest.mock.calls[1]?.[1].calls).toEqual([
        ...autoSwapCalls,
        expect.objectContaining({ address: currency, functionName: 'transferWithMemo' }),
      ])
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.doUnmock('../internal/machine-token-charge.js')
      vi.doUnmock('../internal/auto-swap.js')
      vi.resetModules()
    }
  })

  test('passes machine-token calls to a scoped account resolver', async () => {
    vi.resetModules()
    const chainId = 42431
    const selectedAccount = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    )
    const machineTokenCalls = [
      { data: '0x1234', to: '0x4444444444444444444444444444444444444444' },
      { data: '0x5678', to: '0x5555555555555555555555555555555555555555' },
    ]
    const findRoute = vi.fn(async () => ({ calls: machineTokenCalls }))
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute,
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))

    try {
      const { charge: chargeWithMockedRoute } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const resolveAccount = vi.fn((info: charge.ResolveAccountInfo) => {
        if (info.operation.kind !== 'executeCalls' || !info.operation.calls)
          throw new Error('scoped account requires calls')
        return selectedAccount
      })
      const method = chargeWithMockedRoute({
        account,
        getClient: () => client,
        resolveAccount,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({
            amount: '1',
            chainId,
            machineTokenEnabled: true,
            supportedModes: ['pull'],
          }),
          context: {},
        }),
      )

      expect(resolveAccount).toHaveBeenCalledOnce()
      expect(resolveAccount.mock.calls[0]?.[0].operation).toEqual({
        calls: machineTokenCalls,
        kind: 'executeCalls',
      })
      expect(findRoute).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ account: selectedAccount.address }),
      )
      expect(prepareTransactionRequest).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ account: selectedAccount, calls: machineTokenCalls }),
      )
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${selectedAccount.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('../internal/machine-token-charge.js')
      vi.resetModules()
    }
  })

  test('uses direct calls when a scoped account rejects the machine route', async () => {
    vi.resetModules()
    const chainId = 42431
    const selectedAccount = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    )
    const machineTokenCalls = [
      { data: '0x1234', to: '0x4444444444444444444444444444444444444444' },
      { data: '0x5678', to: '0x5555555555555555555555555555555555555555' },
    ]
    const findRoute = vi.fn()
    const prepareTransactionRequest = vi.fn(
      async (_client: unknown, _parameters: { calls: readonly unknown[] }) => ({}),
    )
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      sendCallsSync: vi.fn(),
      signTransaction,
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute,
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))

    try {
      const { charge: chargeWithMockedRoute } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
        transport: http('http://127.0.0.1'),
      })
      const resolveAccount = vi.fn((info: charge.ResolveAccountInfo) => {
        if (info.operation.kind !== 'executeCalls') throw new Error('expected executeCalls')
        if (info.operation.calls === machineTokenCalls)
          throw new Error('machine route is outside this key scope')
        return selectedAccount
      })
      const method = chargeWithMockedRoute({
        account,
        getClient: () => client,
        resolveAccount,
      })

      const credential = Credential.deserialize(
        await method.createCredential({
          challenge: createChallenge({
            amount: '1',
            chainId,
            machineTokenEnabled: true,
            supportedModes: ['pull'],
          }),
          context: {},
        }),
      )

      expect(resolveAccount).toHaveBeenCalledTimes(2)
      expect(resolveAccount.mock.calls[0]?.[0].operation).toEqual({
        calls: machineTokenCalls,
        kind: 'executeCalls',
      })
      expect(resolveAccount.mock.calls[1]?.[0].operation).toMatchObject({
        calls: [expect.objectContaining({ to: currency })],
        kind: 'executeCalls',
      })
      expect(findRoute).not.toHaveBeenCalled()
      expect(prepareTransactionRequest.mock.calls[0]?.[1].calls).toEqual([
        expect.objectContaining({ address: currency, functionName: 'transferWithMemo' }),
      ])
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${selectedAccount.address}`)
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('../internal/machine-token-charge.js')
      vi.resetModules()
    }
  })

  test('broadcasts local machine-token calls as one Tempo transaction', async () => {
    vi.resetModules()
    mockMachFeeSelection()
    const chainId = 4217
    const hash = `0x${'ab'.repeat(32)}`
    const machineTokenCalls = [
      { data: '0x1234', to: '0x4444444444444444444444444444444444444444' },
      { data: '0x5678', to: '0x5555555555555555555555555555555555555555' },
    ]
    const sendCallsSync = vi.fn()
    const sendTransactionSync = vi.fn(async () => ({ transactionHash: hash }))
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(),
      sendCallsSync,
      sendTransactionSync,
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    }))
    vi.doMock('../internal/machine-token-charge.js', () => ({
      findRoute: vi.fn(async () => ({ calls: machineTokenCalls })),
      getRoute: vi.fn(() => ({ calls: machineTokenCalls })),
      isMachineToken: vi.fn(() => false),
    }))

    try {
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: chainId },
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
            machineTokenEnabled: true,
            supportedModes: ['push'],
          }),
          context: {},
        }),
      )

      expect(sendTransactionSync).toHaveBeenCalledWith(
        client,
        expect.objectContaining({
          account,
          calls: machineTokenCalls,
          feeToken: Addresses.pathUsd,
          nonceKey: 'expiring',
        }),
      )
      expect(sendCallsSync).not.toHaveBeenCalled()
      expect(credential.payload).toEqual({ hash, type: 'hash' })
    } finally {
      vi.doUnmock('viem/actions')
      vi.doUnmock('viem/tempo')
      vi.doUnmock('../internal/machine-token-charge.js')
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
      const selectedRoot = privateKeyToAccount(
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      )
      const selectedAccessKey = Account.fromSecp256k1(Secp256k1.randomPrivateKey(), {
        access: selectedRoot,
      })
      expect(accessKey.address).toBe(account.address)
      expect(accessKey.accessKeyAddress).not.toBe(account.address)

      const client = createClient({
        account: accessKey,
        chain: { ...tempoLocalnet, id: 42431 },
        transport: http('http://127.0.0.1'),
      })
      const resolveAccount = vi.fn(() => selectedAccessKey)
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
      expect(resolveAccount).toHaveBeenCalledWith({
        account: accessKey,
        chainId,
        operation: { kind: 'signPaymentProof' },
      })
      expect(signedTypedData?.message.account).toBe(selectedRoot.address)
      expect(credential.payload).toEqual({ signature: '0xdeadbeef', type: 'proof' })
      expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${selectedRoot.address}`)
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
        chain: { ...tempoLocalnet, id: 42431 },
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
    const prepared = {
      feePayerSignature: { r: '0x1', s: '0x2', yParity: 0 },
      feeToken: currency,
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
        chain: { ...tempoLocalnet, id: 42431 },
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
          feePayer: true,
          supportedModes: ['pull'],
        }),
        context: {},
      })

      expect(prepareTransactionRequest).toHaveBeenCalledWith(
        client,
        expect.not.objectContaining({ feePayer: true }),
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
      vi.resetModules()
    }
  })

  describe('validBefore', () => {
    const base = 1_800_000_000
    const at = (seconds: number) => new Date(seconds * 1000).toISOString()

    test.each([
      { label: 'no challenge expiry', now: base, expires: undefined, expected: base + 25 },
      { label: 'expiry after the window', now: base, expires: at(base + 60), expected: base + 25 },
      { label: 'expiry inside the window', now: base, expires: at(base + 10), expected: base + 11 },
      { label: 'fractional expiry', now: base, expires: at(base + 10.5), expected: base + 11 },
      { label: 'sub-second expiry', now: base + 0.2, expires: at(base + 0.5), expected: base + 1 },
      { label: 'expiry is now', now: base + 0.5, expires: at(base + 0.5), expected: base + 1 },
      { label: 'whole-second expiry is now', now: base, expires: at(base), expected: base + 1 },
      {
        label: 'millisecond expiry',
        now: base + 0.998,
        expires: at(base + 0.999),
        expected: base + 1,
      },
    ])('caps at the challenge expiry: $label', async ({ now, expires, expected }) => {
      vi.resetModules()
      vi.useFakeTimers({ now: now * 1000, toFake: ['Date'] })
      const prepareTransactionRequest = vi.fn(
        async (_client: unknown, _parameters: Record<string, unknown>) => ({}),
      )
      vi.doMock('viem/actions', () => ({
        prepareTransactionRequest,
        sendCallsSync: vi.fn(),
        signTransaction: vi.fn(async () => '0xdeadbeef'),
        signTypedData: vi.fn(),
      }))

      try {
        const { charge: chargeWithMockedActions } = await import('./Charge.js')
        const client = createClient({
          account,
          chain: { ...tempoLocalnet, id: 42431 },
          transport: http('http://127.0.0.1'),
        })
        const method = chargeWithMockedActions({ account, getClient: () => client })

        await method.createCredential({
          challenge: {
            ...createChallenge({ amount: '1', chainId: 42431, supportedModes: ['pull'] }),
            ...(expires ? { expires } : {}),
          },
          context: {},
        })

        const parameters = prepareTransactionRequest.mock.calls[0]?.[1]
        expect(parameters).toMatchObject({ nonceKey: 'expiring', validBefore: expected })
        // Still valid at signing time, even when the challenge expires this second.
        expect(parameters?.validBefore).toBeGreaterThan(now)
      } finally {
        vi.useRealTimers()
        vi.doUnmock('viem/actions')
        vi.resetModules()
      }
    })
  })

  describe('in-flight signing', () => {
    const challenge = (id = 'shared', recipient?: Address) => {
      const base = createChallenge({ amount: '1', chainId: 42431, supportedModes: ['pull'] })
      return { ...base, id, request: { ...base.request, ...(recipient ? { recipient } : {}) } }
    }

    async function setup(options: Partial<Parameters<typeof charge>[0]> = {}) {
      vi.resetModules()
      let signings = 0
      const signTransaction = vi.fn(async () => `0x76${(signings++).toString(16).padStart(4, '0')}`)
      vi.doMock('viem/actions', () => ({
        prepareTransactionRequest: vi.fn(async () => ({})),
        sendCallsSync: vi.fn(),
        signTransaction,
        signTypedData: vi.fn(),
      }))
      const { charge: chargeWithMockedActions } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: 42431 },
        transport: http('http://127.0.0.1'),
      })
      const method = chargeWithMockedActions({ account, getClient: () => client, ...options })
      return { method, signTransaction }
    }

    afterEach(() => {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    })

    test.each([
      { label: 'concurrent, same challenge', concurrent: true, otherId: 'shared', signings: 1 },
      { label: 'sequential, same challenge', concurrent: false, otherId: 'shared', signings: 2 },
      { label: 'concurrent, other challenge', concurrent: true, otherId: 'other', signings: 2 },
    ])('signings: $label', async ({ concurrent, otherId, signings }) => {
      const { method, signTransaction } = await setup()
      const create = (id: string) =>
        method.createCredential({ challenge: challenge(id), context: {} })

      const [first, second] = concurrent
        ? await Promise.all([create('shared'), create(otherId)])
        : [await create('shared'), await create(otherId)]

      expect(signTransaction).toHaveBeenCalledTimes(signings)
      expect(first === second).toBe(signings === 1)
    })

    test('does not share a failed signing with a later call', async () => {
      const { method, signTransaction } = await setup()
      signTransaction.mockRejectedValueOnce(new Error('rpc down'))

      await expect(
        method.createCredential({ challenge: challenge(), context: {} }),
      ).rejects.toThrow('rpc down')
      await method.createCredential({ challenge: challenge(), context: {} })

      expect(signTransaction).toHaveBeenCalledTimes(2)
    })

    test('enforces client policy when joining a signing', async () => {
      const { method, signTransaction } = await setup({ expectedRecipients: [recipient] })

      const [first, second] = await Promise.allSettled([
        method.createCredential({ challenge: challenge(), context: {} }),
        method.createCredential({
          challenge: challenge('shared', '0x4444444444444444444444444444444444444444'),
          context: {},
        }),
      ])

      expect(first.status).toBe('fulfilled')
      expect(second).toMatchObject({
        reason: expect.objectContaining({ message: expect.stringContaining('recipient') }),
        status: 'rejected',
      })
      expect(signTransaction).toHaveBeenCalledOnce()
    })
  })

  describe('transaction hash', () => {
    const envelope = TxEnvelopeTempo.from({
      calls: [{ data: '0x', to: recipient }],
      chainId: 42431,
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 0n,
    })
    const signature = Secp256k1.sign({
      payload: TxEnvelopeTempo.getSignPayload(envelope),
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })
    const unsponsored = TxEnvelopeTempo.serialize(envelope, { signature })
    const cosigned = TxEnvelopeTempo.serialize(
      TxEnvelopeTempo.from({ ...envelope, feePayerSignature: signature }),
      { signature },
    )
    const awaitingFeePayer = TxEnvelopeTempo.from({ ...envelope, feePayerSignature: null })

    test.each([
      ['unsponsored', { signature: unsponsored, type: 'transaction' }, keccak256(unsponsored)],
      ['fee payer co-signed', { signature: cosigned, type: 'transaction' }, keccak256(cosigned)],
      [
        'sponsored envelope',
        {
          signature: TxEnvelopeTempo.serialize(awaitingFeePayer, { format: 'feePayer', signature }),
          type: 'transaction',
        },
        undefined,
      ],
      [
        'awaiting fee payer',
        {
          signature: TxEnvelopeTempo.serialize(awaitingFeePayer, { signature }),
          type: 'transaction',
        },
        undefined,
      ],
      [
        'unsigned',
        { signature: TxEnvelopeTempo.serialize(envelope), type: 'transaction' },
        undefined,
      ],
      ['trailing bytes', { signature: `${unsponsored}00`, type: 'transaction' }, undefined],
      ['malformed', { signature: '0x76ff', type: 'transaction' }, undefined],
      ['non-Tempo', { signature: '0x02c0', type: 'transaction' }, undefined],
      [
        'push',
        {
          hash: '0xabababababababababababababababababababababababababababababababab',
          type: 'hash',
        },
        '0xabababababababababababababababababababababababababababababababab',
      ],
      ['malformed push', { hash: '0xabc', type: 'hash' }, undefined],
      ['proof', { signature: '0x01', type: 'proof' }, undefined],
    ])('derives %s credentials', (_name, payload, expected) => {
      const credential = Credential.serialize({ challenge: createChallenge(), payload })

      expect(MethodResponse.getTransactionHash(charge(), credential)).toBe(expected)
    })
  })

  describe('chain pinning', () => {
    test('rejects a resolved client whose chain conflicts with the pin', async () => {
      const method = charge({ account, expectedChainId: 4217, getClient: () => client })
      await expect(
        method.createCredential({ challenge: createChallenge(), context: {} }),
      ).rejects.toThrow('Chain ID mismatch: expected 4217, got 42431.')
    })

    const client = createClient({
      account,
      chain: { ...tempoLocalnet, id: 42431 },
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

    test('unpinned client rejects a resolved client on another chain', async () => {
      const method = charge({ account, getClient: () => client })
      await expect(
        method.createCredential({ challenge: createChallenge({ chainId: 1 }), context: {} }),
      ).rejects.toThrow('Chain ID mismatch: expected 1, got 42431.')
    })
  })
})

describe('charge chain allowlists', () => {
  test.each([
    { allowed: [4217, 42431], advertised: 4217, resolved: 4217, pin: undefined, accepted: true },
    { allowed: [4217, 42431], advertised: 42431, resolved: 42431, pin: undefined, accepted: true },
    {
      allowed: [4217, 42431],
      advertised: undefined,
      resolved: 42431,
      pin: undefined,
      accepted: true,
    },
    { allowed: [42431], advertised: undefined, resolved: 42431, pin: undefined, accepted: true },
    { allowed: [4217, 42431], advertised: undefined, resolved: 1, pin: undefined, accepted: false },
    { allowed: [], advertised: undefined, resolved: 42431, pin: undefined, accepted: false },
    { allowed: [], advertised: 42431, resolved: 42431, pin: undefined, accepted: false },
    { allowed: [4217], advertised: undefined, resolved: 42431, pin: 42431, accepted: false },
    { allowed: [4217, 42431], advertised: 1, resolved: 1, pin: undefined, accepted: false },
  ])(
    'enforces $allowed for challenge $advertised, client $resolved, and pin $pin',
    async ({ allowed, advertised, resolved, pin, accepted }) => {
      const getClient = vi.fn(() =>
        createClient({
          account,
          chain: { ...tempoLocalnet, id: resolved },
          transport: http('http://127.0.0.1'),
        }),
      )
      const signTypedData = vi.spyOn(account, 'signTypedData')
      const method = charge({ account, allowedChainIds: allowed, expectedChainId: pin, getClient })
      try {
        const result = method.createCredential({
          challenge: createChallenge({ chainId: advertised }),
          context: {},
        })
        if (accepted) {
          expect(Credential.deserialize(await result).source).toBe(
            `did:pkh:eip155:${resolved}:${account.address}`,
          )
        } else {
          await expect(result).rejects.toThrow('Chain ID not allowed')
          expect(signTypedData).not.toHaveBeenCalled()
          if (advertised !== undefined || allowed.length === 0)
            expect(getClient).not.toHaveBeenCalled()
        }
      } finally {
        signTypedData.mockRestore()
      }
    },
  )
})

describe('recipient allowlist', () => {
  test.each([
    { name: 'no splits', splits: undefined },
    { name: 'allowed split', splits: [{ recipient: currency, amount: '0.1' }] },
  ])('rejects an unlisted primary recipient with $name', async ({ splits }) => {
    const resolveAccount = vi.fn(() => account)
    const client = createClient({
      account,
      chain: { ...tempoLocalnet, id: 42431 },
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account,
      getClient: () => client,
      expectedRecipients: [currency],
      resolveAccount,
    })
    await expect(
      method.createCredential({
        challenge: createChallenge({ amount: '1', splits }),
        context: {},
      }),
    ).rejects.toThrow(`Unexpected primary recipient: ${recipient}`)
    expect(resolveAccount).not.toHaveBeenCalled()
  })

  test.each([
    {
      name: 'matching recipients',
      allowed: [recipient, currency],
      splits: [{ recipient: currency, amount: '0.1' }],
      error: undefined,
    },
    {
      name: 'unlisted split',
      allowed: [recipient],
      splits: [{ recipient: currency, amount: '0.1' }],
      error: `Unexpected split recipient: ${currency}`,
    },
    {
      name: 'empty allowlist',
      allowed: [],
      splits: undefined,
      error: `Unexpected primary recipient: ${recipient}`,
    },
    { name: 'no allowlist', allowed: undefined, splits: undefined, error: undefined },
  ])('$name', async ({ allowed, splits, error }) => {
    vi.resetModules()
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest: vi.fn(async () => ({})),
      signTransaction,
      sendCallsSync: vi.fn(),
      signTypedData: vi.fn(),
    }))
    try {
      const { charge: mockedCharge } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: 42431 },
        transport: http('http://127.0.0.1'),
      })
      const method = mockedCharge({
        account,
        getClient: () => client,
        expectedRecipients: allowed as readonly Address[] | undefined,
      })
      const result = method.createCredential({
        challenge: createChallenge({ amount: '1', splits, supportedModes: ['pull'] }),
        context: {},
      })
      if (error) {
        await expect(result).rejects.toThrow(error)
        expect(signTransaction).not.toHaveBeenCalled()
      } else {
        expect(Credential.deserialize(await result).payload).toEqual({
          signature: '0xdeadbeef',
          type: 'transaction',
        })
        expect(signTransaction).toHaveBeenCalledOnce()
      }
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })
})

describe('amount cap', () => {
  const atomicError = 'Tempo charge amount exceeds maxAtomicAmount.'
  const displayError = 'Tempo charge amount exceeds maxAmount.'
  const decimalsError = 'Tempo charge maxAmount requires currency decimals.'
  const currenciesError = 'Tempo charge maxAmount and maxAtomicAmount require currencies.'

  // The challenge charges 1 token (1_000_000 base units at 6 decimals).
  test.each([
    { name: 'atomic below cap', options: { maxAtomicAmount: '1000001' }, error: undefined },
    { name: 'atomic equal to cap', options: { maxAtomicAmount: '1000000' }, error: undefined },
    { name: 'atomic above cap', options: { maxAtomicAmount: '999999' }, error: atomicError },
    { name: 'atomic zero cap', options: { maxAtomicAmount: '0' }, error: atomicError },
    {
      name: 'display below cap',
      options: { decimals: 6, maxAmount: '1.000001' },
      error: undefined,
    },
    { name: 'display equal to cap', options: { decimals: 6, maxAmount: '1' }, error: undefined },
    {
      name: 'display above cap',
      options: { decimals: 6, maxAmount: '0.999999' },
      error: displayError,
    },
    {
      name: 'atomic cap with passing display cap',
      options: { decimals: 6, maxAmount: '2', maxAtomicAmount: '999999' },
      error: atomicError,
    },
    { name: 'no cap', options: {}, error: undefined },
    {
      name: 'unlisted currency',
      options: { currencies: [otherCurrency] },
      error: `Tempo charge currency is not allowed: ${currency}.`,
    },
  ])('$name', async ({ options, error }) => {
    vi.resetModules()
    const prepareTransactionRequest = vi.fn(async () => ({}))
    const signTransaction = vi.fn(async () => '0xdeadbeef')
    vi.doMock('viem/actions', () => ({
      prepareTransactionRequest,
      signTransaction,
      sendCallsSync: vi.fn(),
      signTypedData: vi.fn(),
    }))
    try {
      const { charge: mockedCharge } = await import('./Charge.js')
      const client = createClient({
        account,
        chain: { ...tempoLocalnet, id: 42431 },
        transport: http('http://127.0.0.1'),
      })
      const resolveAccount = vi.fn(() => account)
      const method = mockedCharge({
        account,
        getClient: () => client,
        resolveAccount,
        currencies: [currency],
        ...(options as charge.Parameters),
      })
      const result = method.createCredential({
        challenge: createChallenge({
          amount: '1',
          splits: [{ recipient: currency, amount: '0.4' }],
          supportedModes: ['pull'],
        }),
        context: {},
      })
      if (error) {
        await expect(result).rejects.toThrow(error)
        expect(resolveAccount).not.toHaveBeenCalled()
        expect(prepareTransactionRequest).not.toHaveBeenCalled()
        expect(signTransaction).not.toHaveBeenCalled()
      } else {
        expect(Credential.deserialize(await result).payload).toEqual({
          signature: '0xdeadbeef',
          type: 'transaction',
        })
        expect(signTransaction).toHaveBeenCalledOnce()
      }
    } finally {
      vi.doUnmock('viem/actions')
      vi.resetModules()
    }
  })

  test.each([
    {
      name: 'atomic cap without currencies',
      options: { currencies: undefined, maxAtomicAmount: '1' },
      error: currenciesError,
    },
    {
      name: 'display cap without currencies',
      options: { currencies: undefined, decimals: 6, maxAmount: '1' },
      error: currenciesError,
    },
    { name: 'display cap without decimals', options: { maxAmount: '2' }, error: decimalsError },
    {
      name: 'display cap finer than decimals',
      options: { decimals: 6, maxAmount: '1.0000005' },
      error: 'Tempo charge maxAmount 1.0000005 has more fractional digits than 6 decimals allow.',
    },
    {
      name: 'display cap with trailing zeros',
      options: { decimals: 6, maxAmount: '1.0000000' },
      error: undefined,
    },
  ])('$name at config time', ({ options, error }) => {
    const create = () => charge({ account, currencies: [currency], ...options })
    if (error) expect(create).toThrow(error)
    else expect(create).not.toThrow()
  })

  test('accepts zero-amount proofs under a zero cap', async () => {
    const signer = { ...account }
    const signTypedData = vi.spyOn(signer, 'signTypedData')
    const client = createClient({
      account: signer,
      chain: { ...tempoLocalnet, id: 42431 },
      transport: http('http://127.0.0.1'),
    })
    const method = charge({
      account: signer,
      currencies: [currency],
      getClient: () => client,
      maxAtomicAmount: '0',
    })
    const credential = await method.createCredential({ challenge: createChallenge(), context: {} })
    expect(Credential.deserialize(credential).payload).toMatchObject({ type: 'proof' })
    expect(signTypedData).toHaveBeenCalledOnce()
  })
})

describe('challenge selection policy', () => {
  test.each([
    {
      name: 'atomic cap skips an over-cap offer',
      options: { currencies: [currency], maxAtomicAmount: '1000000' },
      offers: [{ amount: '2' }, { amount: '0.5' }],
      selected: 1,
    },
    {
      name: 'atomic cap rejects all over-cap offers',
      options: { currencies: [currency], maxAtomicAmount: '1000000' },
      offers: [{ amount: '2' }, { amount: '3' }],
      selected: undefined,
    },
    {
      name: 'display cap skips an over-cap offer',
      options: { currencies: [currency], decimals: 6, maxAmount: '1' },
      offers: [{ amount: '2' }, { amount: '0.5' }],
      selected: 1,
    },
    {
      name: 'display cap rejects all over-cap offers',
      options: { currencies: [currency], decimals: 6, maxAmount: '1' },
      offers: [{ amount: '2' }, { amount: '3' }],
      selected: undefined,
    },
    {
      name: 'currency allowlist skips a wrong-currency offer',
      options: { currencies: [currency], maxAtomicAmount: '1000000' },
      offers: [
        { amount: '0.5', currency: otherCurrency },
        { amount: '0.5', currency },
      ],
      selected: 1,
    },
    {
      name: 'currency allowlist rejects all wrong-currency offers',
      options: { currencies: [currency], maxAtomicAmount: '1000000' },
      offers: [
        { amount: '0.5', currency: otherCurrency },
        { amount: '0.5', currency: otherCurrency },
      ],
      selected: undefined,
    },
    {
      name: 'recipient allowlist skips a disallowed primary recipient',
      options: { expectedRecipients: [recipient] },
      offers: [{ recipient: currency }, { recipient }],
      selected: 1,
    },
    {
      name: 'recipient allowlist skips a disallowed split recipient',
      options: { expectedRecipients: [recipient] },
      offers: [{ amount: '1', splits: [{ recipient: currency, amount: '0.1' }] }, { amount: '1' }],
      selected: 1,
    },
    {
      name: 'recipient allowlist rejects all disallowed offers',
      options: { expectedRecipients: [recipient] },
      offers: [{ recipient: currency }, { recipient: currency }],
      selected: undefined,
    },
    {
      name: 'chain pin skips a mismatched chain',
      options: { expectedChainId: 42431 },
      offers: [{ chainId: 4217 }, { chainId: 42431 }],
      selected: 1,
    },
    {
      name: 'chain allowlist rejects all disallowed chains',
      options: { allowedChainIds: [4217] },
      offers: [{ chainId: 42431 }, { chainId: 1 }],
      selected: undefined,
    },
  ])('$name', async ({ options, offers, selected }) => {
    const mppx = Mppx.create({
      methods: [charge({ account, ...(options as charge.Parameters) })],
      polyfill: false,
    })
    const challenges = offers.map((offer, index) => ({
      ...createChallenge(offer),
      id: `offer-${index}`,
    }))
    const response = new Response(null, {
      headers: { 'WWW-Authenticate': challenges.map(Challenge.serialize).join(', ') },
      status: 402,
    })
    // Zero-amount proofs are only signed for the server that owns the realm.
    Object.defineProperty(response, 'url', { value: 'https://api.example.com/resource' })
    const prepared = mppx.preparePayment(response)
    if (selected === undefined)
      await expect(prepared).rejects.toThrow('No method found for challenges')
    else expect((await prepared).challenge.id).toBe(`offer-${selected}`)
  })
})

describe('zero-amount recipient policy', () => {
  test.each([{ allowed: [] }, { allowed: [currency] }, { allowed: [recipient] }])(
    'enforces allowlist %j before proof signing',
    async ({ allowed }) => {
      const signer = { ...account }
      const signTypedData = vi.spyOn(signer, 'signTypedData')
      const client = createClient({
        account: signer,
        chain: { ...tempoLocalnet, id: 42431 },
        transport: http('http://127.0.0.1'),
      })
      const method = charge({
        account: signer,
        getClient: () => client,
        expectedRecipients: allowed as Address[],
      })
      const pending = method.createCredential({ challenge: createChallenge(), context: {} })
      if (allowed.includes(recipient)) {
        expect(Credential.deserialize(await pending).payload).toMatchObject({ type: 'proof' })
        expect(signTypedData).toHaveBeenCalledOnce()
      } else {
        await expect(pending).rejects.toThrow('Unexpected primary recipient')
        expect(signTypedData).not.toHaveBeenCalled()
      }
    },
  )
})
