import {
  type Address,
  createClient,
  custom,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import type { SessionReceipt } from '../../session/Types.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import * as ClientOps from '../client/ChannelOps.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import type { SessionCredentialPayload } from '../Types.js'
import * as Types from '../Types.js'
import * as Voucher from '../Voucher.js'
import { session } from './Session.js'

const payer = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const wrongPayer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f094538a009d74290f5811cfba6a6b4d238ff944',
)
const chainId = 42431
const payee = '0x0000000000000000000000000000000000000002' as Address
const token = '0x0000000000000000000000000000000000000003' as Address
const wrongTarget = '0x0000000000000000000000000000000000000004' as Address

type RpcCall = { method: string; params?: unknown }

function createSigningClient(account = payer) {
  return createClient({
    account,
    chain: { id: chainId } as never,
    transport: custom({
      async request(args) {
        if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (args.method === 'eth_getTransactionCount') return '0x0'
        if (args.method === 'eth_estimateGas') return '0x5208'
        if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
        if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
        throw new Error(`unexpected signing rpc request: ${args.method}`)
      },
    }),
  })
}

function createServerClient(
  calls: RpcCall[] = [],
  account: typeof payer | null = payer,
  _eventChannelId: Hex = `0x${'00'.repeat(32)}` as Hex,
) {
  return createClient({
    ...(account ? { account } : {}),
    chain: { id: chainId } as never,
    transport: custom({
      async request(args) {
        calls.push(args)
        if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (args.method === 'eth_getTransactionCount') return '0x0'
        if (args.method === 'eth_estimateGas') return '0x5208'
        if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
        if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
        if (args.method === 'eth_sendRawTransaction') return `0x${'aa'.repeat(32)}`
        if (args.method === 'eth_sendTransaction') return `0x${'bb'.repeat(32)}`
        if (args.method === 'eth_call')
          return encodeFunctionResult({
            abi: escrowAbi,
            functionName: 'getChannelState',
            result: { settled: 100n, deposit: 1_000n, closeRequestedAt: 0 },
          })
        throw new Error(`unexpected rpc request: ${args.method}`)
      },
    }),
  })
}

function createStateClient(
  account: typeof payer | null = payer,
  state: { settled: bigint; deposit: bigint; closeRequestedAt: number } = {
    settled: 0n,
    deposit: 1_000n,
    closeRequestedAt: 0,
  },
) {
  return createClient({
    ...(account ? { account } : {}),
    chain: { id: chainId } as never,
    transport: custom({
      async request(args) {
        if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (args.method === 'eth_call')
          return encodeFunctionResult({
            abi: escrowAbi,
            functionName: 'getChannelState',
            result: state,
          })
        if (args.method === 'eth_getTransactionCount') return '0x0'
        if (args.method === 'eth_estimateGas') return '0x5208'
        if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
        if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
        throw new Error(`unexpected rpc request: ${args.method}`)
      },
    }),
  })
}

function createServer(parameters: Partial<session.Parameters> = {}) {
  const rawStore = Store.memory()
  const rpcCalls: RpcCall[] = []
  const serverClient = createServerClient(rpcCalls)
  const method = session({
    amount: '1',
    chainId,
    currency: token,
    decimals: 0,
    recipient: payee,
    store: rawStore,
    unitType: 'request',
    getClient: () => serverClient,
    ...parameters,
  })
  return { method, store: ChannelStore.fromStore(rawStore as never), rpcCalls }
}

function makeChallenge(channelId?: Hex): any {
  return {
    id: 'challenge-id',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '100',
      currency: token,
      recipient: payee,
      methodDetails: {
        chainId,
        escrowContract: tip20ChannelEscrow,
        ...(channelId && { channelId }),
      },
    },
  }
}

function makeRequest(channelId?: Hex) {
  return makeChallenge(channelId).request
}

let saltCounter = 0

async function createOpenPayload(
  parameters: {
    deposit?: bigint | undefined
    initialAmount?: bigint | undefined
    escrow?: Address | undefined
    account?: typeof payer | undefined
    operator?: Address | undefined
  } = {},
): Promise<Extract<SessionCredentialPayload, { action: 'open' }>> {
  const account = parameters.account ?? payer
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const initialAmount = Types.uint96(parameters.initialAmount ?? 100n)
  const deposit = Types.uint96(parameters.deposit ?? 1_000n)
  const salt = `0x${(++saltCounter).toString(16).padStart(64, '0')}` as Hex
  const operator = parameters.operator ?? zeroAddress
  const authorizedSigner = account.address
  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [payee, operator, token, deposit, salt, authorizedSigner],
  })
  const signingClient = createSigningClient(account)
  const transaction = (await Transaction.serialize({
    chainId,
    calls: [{ to: escrow, data }],
    feeToken: token,
    nonce: 0,
  })) as Hex
  const expiringNonceHash = Channel.computeExpiringNonceHash(
    Transaction.deserialize(
      transaction as Transaction.TransactionSerializedTempo,
    ) as Channel.ExpiringNonceTransaction,
    { sender: account.address },
  )
  const descriptor = {
    payer: account.address,
    payee,
    operator,
    token,
    salt,
    authorizedSigner,
    expiringNonceHash,
  } satisfies Channel.ChannelDescriptor
  const channelId = Channel.computeId({ ...descriptor, chainId, escrow })
  const signature = await Voucher.signVoucher(
    signingClient,
    account,
    { channelId, cumulativeAmount: initialAmount },
    escrow,
    chainId,
  )
  return {
    action: 'open',
    type: 'transaction',
    channelId,
    transaction,
    signature,
    descriptor,
    cumulativeAmount: initialAmount.toString(),
    authorizedSigner: descriptor.authorizedSigner,
  }
}

async function persistPrecompileChannel(
  store: ChannelStore.ChannelStore,
  payload: Extract<SessionCredentialPayload, { action: 'open' }>,
  overrides: Partial<ChannelStore.State> = {},
) {
  await store.updateChannel(payload.channelId, () => ({
    backend: 'precompile',
    channelId: payload.channelId,
    chainId,
    escrowContract: tip20ChannelEscrow,
    closeRequestedAt: 0n,
    payer: payload.descriptor.payer,
    payee,
    token,
    authorizedSigner: payload.descriptor.authorizedSigner,
    deposit: 1_000n,
    settledOnChain: 0n,
    highestVoucherAmount: BigInt(payload.cumulativeAmount),
    highestVoucher: {
      channelId: payload.channelId,
      cumulativeAmount: BigInt(payload.cumulativeAmount),
      signature: payload.signature,
    },
    spent: 0n,
    units: 0,
    finalized: false,
    createdAt: new Date(0).toISOString(),
    descriptor: payload.descriptor,
    operator: payload.descriptor.operator,
    salt: payload.descriptor.salt,
    expiringNonceHash: payload.descriptor.expiringNonceHash,
    ...overrides,
  }))
}

describe('precompile server session unit guardrails', () => {
  test('request normalizes fee-payer to boolean for challenge issuance and account for verification', async () => {
    const { method } = createServer({ feePayer: wrongPayer })

    const challengeRequest = await method.request!({
      credential: null,
      request: {
        amount: '1',
        currency: token,
        decimals: 0,
        recipient: payee,
        unitType: 'request',
      },
    } as never)
    expect(challengeRequest.feePayer).toBe(true)

    const verificationRequest = await method.request!({
      credential: { challenge: {}, payload: {} } as never,
      request: {
        amount: '1',
        currency: token,
        decimals: 0,
        feePayer: payer,
        recipient: payee,
        unitType: 'request',
      },
    } as never)
    expect(verificationRequest.feePayer).toBe(payer)
  })

  test('request allows callers to explicitly disable precompile fee-payer', async () => {
    const { method } = createServer({ feePayer: wrongPayer })

    const challengeRequest = await method.request!({
      credential: null,
      request: {
        amount: '1',
        currency: token,
        decimals: 0,
        feePayer: false,
        recipient: payee,
        unitType: 'request',
      },
    } as never)
    expect(challengeRequest.feePayer).toBeUndefined()

    const verificationRequest = await method.request!({
      credential: { challenge: {}, payload: {} } as never,
      request: {
        amount: '1',
        currency: token,
        decimals: 0,
        feePayer: false,
        recipient: payee,
        unitType: 'request',
      },
    } as never)
    expect(verificationRequest.feePayer).toBe(false)
  })

  test('request throws when resolved precompile client chain mismatches requested chain', async () => {
    const { method } = createServer({ chainId: 1 })

    await expect(
      method.request!({
        credential: null,
        request: {
          amount: '1',
          chainId: 1,
          currency: token,
          decimals: 0,
          recipient: payee,
          unitType: 'request',
        },
      } as never),
    ).rejects.toThrow('Client not configured with chainId 1.')
  })

  test('rejects open transactions targeting the wrong address', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload({ escrow: wrongTarget })

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(payload.channelId), payload },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/channelId does not match descriptor|wrong address/)
  })

  test('rejects smuggled extra calls in open transactions', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload()
    const tampered = await createOpenPayload()

    // Reuse a valid descriptor/signature, but submit a transaction whose calls
    // do not correspond to that descriptor. This exercises the same one-call /
    // smuggling guard as legacy server session tests without requiring a live
    // chain-backed precompile.
    const smuggled = { ...payload, transaction: tampered.transaction }

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(payload.channelId),
          payload: smuggled,
        },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/does not match/)
  })

  test('rejects descriptors that do not match the challenge channel ID', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload()
    const badDescriptor = {
      ...payload.descriptor,
      token: '0x0000000000000000000000000000000000000005' as Address,
    }

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(payload.channelId),
          payload: { ...payload, descriptor: badDescriptor },
        },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/channelId does not match descriptor/)
  })

  test('rejects invalid initial voucher signatures', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload()
    const badSignaturePayload = {
      ...payload,
      signature: (await createOpenPayload({ account: wrongPayer })).signature,
    }

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(payload.channelId),
          payload: badSignaturePayload,
        },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/invalid voucher signature/)
  })

  test('rejects missing precompile descriptors with a verification error', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload()
    const { descriptor: _descriptor, ...payloadWithoutDescriptor } = payload

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(payload.channelId),
          payload: payloadWithoutDescriptor,
        },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/descriptor required for precompile session action/)
  })

  test('rejects uint96 overflow in credential amount parsing', async () => {
    const { method } = createServer()
    const payload = await createOpenPayload()

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(payload.channelId),
          payload: { ...payload, cumulativeAmount: (1n << 96n).toString() },
        },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/outside uint96 bounds/)
  })

  test('rejects settle when no account is available', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], null), openPayload.channelId),
    ).rejects.toThrow(/no account available/)
  })

  test('rejects settle when sender is not the channel payee or operator', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], wrongPayer), openPayload.channelId),
    ).rejects.toThrow(/tx sender .* is not the channel payee/)
  })

  test('accepts settle sender matching a nonzero precompile operator', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload({
      operator: wrongPayer.address,
    })
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    const client = createClient({
      account: wrongPayer,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      }),
    })
    await expect(settle(store, client, openPayload.channelId)).rejects.toThrow(
      /eth_getTransactionCount/,
    )
  })

  test('precompile settle fee payer options still enforce payee sender policy', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], payer), openPayload.channelId, {
        feePayer: wrongPayer,
      }),
    ).rejects.toThrow(/tx sender .* is not the channel payee/)
  })

  test('accepts precompile settle fee token options', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
    })
    const client = createClient({
      account: payer,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          if (args.method === 'eth_sendTransaction') throw new Error('sent fee-token settle')
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      }),
    })

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, client, openPayload.channelId, {
        feeToken: token,
      }),
    ).rejects.toThrow(/eth_getTransactionCount/)
  })

  test('accepts settle account override matching the channel payee', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: wrongPayer.address,
    })
    const client = createClient({
      account: payer,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          if (args.method === 'eth_sendTransaction') throw new Error('sent settle transaction')
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      }),
    })

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, client, openPayload.channelId, {
        account: wrongPayer,
      }),
    ).rejects.toThrow(/eth_getTransactionCount/)
  })

  test('rejects precompile settle fee-payer policy violations', async () => {
    const { store } = createServer()
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
    })

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], payer), openPayload.channelId, {
        feePayer: wrongPayer,
        feePayerPolicy: { maxGas: 1n },
        feeToken: token,
      }),
    ).rejects.toThrow(/fee-payer policy maxGas exceeded/)
  })

  test('rejects close voucher below local spent', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
      spent: 150n,
    })
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/close voucher amount must be >= 150 \(spent\)/)
  })

  test('rejects close voucher below on-chain settled', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
    })
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () =>
        createStateClient(payer, {
          settled: 100n,
          deposit: 1_000n,
          closeRequestedAt: 0,
        }),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(99n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/close voucher amount must be >= 100 \(on-chain settled\)/)
  })

  test('rejects close capture exceeding on-chain precompile deposit', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
      spent: 100n,
    })
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () =>
        createStateClient(payer, {
          settled: 0n,
          deposit: 99n,
          closeRequestedAt: 0,
        }),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/close capture amount exceeds on-chain deposit/)
  })

  test('rejects close for locally finalized and pending precompile channels', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })

    await persistPrecompileChannel(store, openPayload, {
      finalized: true,
      payee: payer.address,
    })
    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/channel is already finalized/)

    await persistPrecompileChannel(store, openPayload, {
      closeRequestedAt: 1n,
      payee: payer.address,
    })
    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/channel has a pending close request/)
  })

  test('does not let a racing lower voucher regress highest accepted precompile voucher', async () => {
    const openPayload = await createOpenPayload({ initialAmount: 100n })
    const lowerVoucher = await ClientOps.createVoucherPayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(200n), chainId)
    const higherVoucher = await ClientOps.createVoucherPayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(500n), chainId)
    if (higherVoucher.action !== 'voucher') throw new Error('expected voucher payload')

    const seedStore = ChannelStore.fromStore(Store.memory() as never)
    await persistPrecompileChannel(seedStore, openPayload, {
      highestVoucherAmount: 100n,
      highestVoucher: {
        channelId: openPayload.channelId,
        cumulativeAmount: 100n,
        signature: openPayload.signature,
      },
    })
    const stale = (await seedStore.getChannel(openPayload.channelId))!
    let stored: ChannelStore.State = {
      ...stale,
      highestVoucherAmount: 500n,
      highestVoucher: {
        channelId: openPayload.channelId,
        cumulativeAmount: 500n,
        signature: higherVoucher.signature,
      },
    }
    const racingStore = {
      async get(_key: string) {
        return stale as never
      },
      async put(_key: string, value: unknown) {
        stored = value as ChannelStore.State
      },
      async delete(_key: string) {},
      async update<result>(
        _key: string,
        fn: (current: unknown | null) => Store.Change<unknown, result>,
      ): Promise<result> {
        const change = fn(stored)
        if (change.op === 'set') stored = change.value as ChannelStore.State
        return change.result
      },
    } as Store.AtomicStore
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      channelStateTtl: Number.MAX_SAFE_INTEGER,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: racingStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })

    const receipt = await method.verify({
      credential: {
        challenge: makeChallenge(openPayload.channelId),
        payload: lowerVoucher,
      },
      request: makeRequest(openPayload.channelId) as never,
    })

    expect((receipt as SessionReceipt).acceptedCumulative).toBe('500')
    expect(stored.highestVoucherAmount).toBe(500n)
    expect(stored.highestVoucher?.signature).toBe(higherVoucher.signature)
  })

  test('marks pending precompile close before broadcast and restores it when broadcast fails', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: payer.address,
    })
    let observedPending = false
    const method = session({
      account: payer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () =>
        createClient({
          account: payer,
          chain: { id: chainId } as never,
          transport: custom({
            async request(args) {
              if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
              if (args.method === 'eth_call')
                return encodeFunctionResult({
                  abi: escrowAbi,
                  functionName: 'getChannelState',
                  result: { settled: 0n, deposit: 1_000n, closeRequestedAt: 0 },
                })
              if (args.method === 'eth_getTransactionCount') {
                observedPending =
                  (await store.getChannel(openPayload.channelId))!.closeRequestedAt !== 0n
                throw new Error('broadcast failed')
              }
              if (args.method === 'eth_estimateGas') return '0x5208'
              if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
              if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
              throw new Error(`unexpected rpc request: ${args.method}`)
            },
          }),
        }),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/broadcast failed/)
    expect(observedPending).toBe(true)
    expect((await store.getChannel(openPayload.channelId))!.closeRequestedAt).toBe(0n)
  })

  test('rejects server-driven close when no account is available', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload)
    const method = session({
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(null),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/no account available/)
  })

  test('accepts server-driven close account override matching the channel payee', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: wrongPayer.address,
    })
    const method = session({
      account: wrongPayer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/eth_sendRawTransaction/)
  })

  test('uses request-specified fee payer account for server-driven precompile close', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload, {
      payee: wrongPayer.address,
    })
    const method = session({
      account: wrongPayer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      feeToken: token,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: {
          ...makeRequest(openPayload.channelId),
          feePayer: payer,
          methodDetails: {
            ...makeRequest(openPayload.channelId).methodDetails,
            feePayer: true,
          },
        } as never,
      }),
    ).rejects.toThrow(/eth_sendRawTransaction/)
  })

  test('accepts server-driven close sender matching a nonzero precompile operator', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload({
      operator: wrongPayer.address,
    })
    await persistPrecompileChannel(store, openPayload)
    const method = session({
      account: wrongPayer,
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(payer),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/eth_sendRawTransaction/)
  })

  test('rejects server-driven close when sender is not the channel payee or operator', async () => {
    const rawStore = Store.memory()
    const store = ChannelStore.fromStore(rawStore as never)
    const openPayload = await createOpenPayload()
    await persistPrecompileChannel(store, openPayload)
    const method = session({
      amount: '1',
      chainId,
      currency: token,
      decimals: 0,
      recipient: payee,
      store: rawStore,
      unitType: 'request',
      getClient: () => createStateClient(wrongPayer),
    })
    const payload = await ClientOps.createClosePayload(createSigningClient(), payer, openPayload.descriptor, Types.uint96(100n), chainId)

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload,
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/tx sender .* is not the channel payee/)
  })
})
