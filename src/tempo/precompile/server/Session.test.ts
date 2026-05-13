import { type Address, createClient, custom, type Hex, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import * as ClientOps from '../client/ChannelOps.js'
import { tip20ChannelEscrow } from '../Constants.js'
import type { OpenCredentialPayload } from '../Types.js'
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

function createServerClient(calls: RpcCall[] = [], account: typeof payer | null = payer) {
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

async function createOpenCredential(
  parameters: {
    deposit?: bigint | undefined
    initialAmount?: bigint | undefined
    escrow?: Address | undefined
    account?: typeof payer | undefined
  } = {},
): Promise<OpenCredentialPayload> {
  const account = parameters.account ?? payer
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const initialAmount = Types.uint96(parameters.initialAmount ?? 100n)
  const deposit = Types.uint96(parameters.deposit ?? 1_000n)
  const salt = `0x${(++saltCounter).toString(16).padStart(64, '0')}` as Hex
  const descriptor = {
    payer: account.address,
    payee,
    operator: zeroAddress,
    token,
    salt,
    authorizedSigner: account.address,
    expiringNonceHash: `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex,
  } satisfies Channel.ChannelDescriptor
  const channelId = Channel.computeId(descriptor, { chainId, escrow })
  const data = Chain.encodeOpen({
    payee,
    operator: descriptor.operator,
    token,
    deposit,
    salt,
    authorizedSigner: descriptor.authorizedSigner,
  })
  const signingClient = createSigningClient(account)
  const transaction = (await Transaction.serialize({
    chainId,
    calls: [{ to: escrow, data }],
    feeToken: token,
    nonce: 0,
  })) as Hex
  const signature = await Voucher.sign(
    signingClient,
    account,
    { channelId, cumulativeAmount: initialAmount },
    { chainId, verifyingContract: escrow },
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
  payload: OpenCredentialPayload,
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
  test.skip('accepts a valid open with voucher and persists precompile descriptor state (covered by localnet)', async () => {
    const { method, store, rpcCalls } = createServer()
    const payload = await createOpenCredential()

    const receipt = await method.verify({
      credential: { challenge: makeChallenge(payload.channelId), payload },
      request: makeRequest(payload.channelId) as never,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')
    expect(receipt.reference).toBe(payload.channelId)
    expect(rpcCalls.map((call) => call.method)).toEqual(['eth_sendRawTransaction'])

    const channel = await store.getChannel(payload.channelId)
    expect(channel).not.toBeNull()
    expect(channel!.backend).toBe('precompile')
    expect(ChannelStore.isPrecompileState(channel!)).toBe(true)
    if (!ChannelStore.isPrecompileState(channel!)) throw new Error('expected precompile state')
    expect(channel.descriptor).toEqual(payload.descriptor)
    expect(channel.expiringNonceHash).toBe(payload.descriptor.expiringNonceHash)
    expect(channel.highestVoucherAmount).toBe(100n)
    expect(channel.deposit).toBe(1_000n)
  })

  test('rejects open transactions targeting the wrong address', async () => {
    const { method } = createServer()
    const payload = await createOpenCredential({ escrow: wrongTarget })

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(payload.channelId), payload },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/channelId does not match descriptor|wrong address/)
  })

  test('rejects smuggled extra calls in open transactions', async () => {
    const { method } = createServer()
    const payload = await createOpenCredential()
    const tampered = await createOpenCredential()

    // Reuse a valid descriptor/signature, but submit a transaction whose calls
    // do not correspond to that descriptor. This exercises the same one-call /
    // smuggling guard as legacy server session tests without requiring a live
    // localnet precompile.
    const smuggled = { ...payload, transaction: tampered.transaction }

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(payload.channelId), payload: smuggled },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/does not match/)
  })

  test('rejects descriptors that do not match the challenge channel ID', async () => {
    const { method } = createServer()
    const payload = await createOpenCredential()
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
    const payload = await createOpenCredential()
    const badSignaturePayload = {
      ...payload,
      signature: (await createOpenCredential({ account: wrongPayer })).signature,
    }

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(payload.channelId), payload: badSignaturePayload },
        request: makeRequest(payload.channelId) as never,
      }),
    ).rejects.toThrow(/invalid voucher signature/)
  })

  test('rejects uint96 overflow in credential amount parsing', async () => {
    const { method } = createServer()
    const payload = await createOpenCredential()

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

  test.skip('accepts post-open vouchers using the persisted descriptor (covered by localnet)', async () => {
    const { method, store } = createServer({ channelStateTtl: Number.MAX_SAFE_INTEGER })
    const openPayload = await createOpenCredential()
    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: openPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    const voucherPayload = await ClientOps.createVoucherCredential(createSigningClient(), payer, {
      chainId,
      cumulativeAmount: Types.uint96(250n),
      descriptor: openPayload.descriptor,
    })

    const receipt = await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: voucherPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    expect(receipt.reference).toBe(openPayload.channelId)
    const channel = await store.getChannel(openPayload.channelId)
    expect(channel!.highestVoucherAmount).toBe(250n)
  })

  test.skip('rejects post-open voucher descriptor mismatches (covered by localnet-backed state)', async () => {
    const { method } = createServer({ channelStateTtl: Number.MAX_SAFE_INTEGER })
    const openPayload = await createOpenCredential()
    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: openPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    const voucherPayload = await ClientOps.createVoucherCredential(createSigningClient(), payer, {
      chainId,
      cumulativeAmount: Types.uint96(250n),
      descriptor: openPayload.descriptor,
    })

    await expect(
      method.verify({
        credential: {
          challenge: makeChallenge(openPayload.channelId),
          payload: {
            ...voucherPayload,
            descriptor: { ...voucherPayload.descriptor, salt: `0x${'ff'.repeat(32)}` as Hex },
          },
        },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(
      /descriptor does not match stored channel|channelId does not match descriptor/,
    )
  })

  test.skip('accepts top-up credentials and updates cached deposit (covered by localnet)', async () => {
    const { method, store, rpcCalls } = createServer()
    const openPayload = await createOpenCredential({ deposit: 500n })
    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: openPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    const additionalDeposit = Types.uint96(700n)
    const topUpPayload = ClientOps.createTopUpCredential(
      {
        channelId: openPayload.channelId,
        descriptor: openPayload.descriptor,
        transaction: (await Transaction.serialize({
          chainId,
          calls: [
            {
              to: tip20ChannelEscrow,
              data: Chain.encodeTopUp(openPayload.descriptor, additionalDeposit),
            },
          ],
          feeToken: token,
          nonce: 0,
        })) as Hex,
      },
      additionalDeposit,
    )

    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: topUpPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    const channel = await store.getChannel(openPayload.channelId)
    expect(channel!.deposit).toBe(1_200n)
    expect(rpcCalls.map((call) => call.method)).toEqual([
      'eth_sendRawTransaction',
      'eth_sendRawTransaction',
    ])
  })

  test.skip('rejects top-up calldata for a different descriptor (covered by localnet-backed state)', async () => {
    const { method } = createServer()
    const openPayload = await createOpenCredential({ deposit: 500n })
    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: openPayload },
      request: makeRequest(openPayload.channelId) as never,
    })

    const otherOpen = await createOpenCredential({ deposit: 500n })
    const additionalDeposit = Types.uint96(700n)
    const topUpPayload = {
      ...ClientOps.createTopUpCredential(
        {
          channelId: otherOpen.channelId,
          descriptor: otherOpen.descriptor,
          transaction: (await Transaction.serialize({
            chainId,
            calls: [
              {
                to: tip20ChannelEscrow,
                data: Chain.encodeTopUp(otherOpen.descriptor, additionalDeposit),
              },
            ],
            feeToken: token,
            nonce: 0,
          })) as Hex,
        },
        additionalDeposit,
      ),
      channelId: openPayload.channelId,
      descriptor: openPayload.descriptor,
    }

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(openPayload.channelId), payload: topUpPayload },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/topUp descriptor does not match stored channel/)
  })

  test.skip('rejects vouchers above the cached deposit (covered by localnet-backed state)', async () => {
    const { method } = createServer({ channelStateTtl: Number.MAX_SAFE_INTEGER })
    const openPayload = await createOpenCredential({ deposit: 200n, initialAmount: 100n })
    await method.verify({
      credential: { challenge: makeChallenge(openPayload.channelId), payload: openPayload },
      request: makeRequest(openPayload.channelId) as never,
    })
    const voucherPayload = await ClientOps.createVoucherCredential(createSigningClient(), payer, {
      chainId,
      cumulativeAmount: Types.uint96(201n),
      descriptor: openPayload.descriptor,
    })

    await expect(
      method.verify({
        credential: { challenge: makeChallenge(openPayload.channelId), payload: voucherPayload },
        request: makeRequest(openPayload.channelId) as never,
      }),
    ).rejects.toThrow(/exceeds on-chain deposit/)
  })

  test('rejects settle when no account is available', async () => {
    const { store } = createServer()
    const openPayload = await createOpenCredential()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], null), openPayload.channelId),
    ).rejects.toThrow(/no account available/)
  })

  test('rejects settle when sender is not the channel payee', async () => {
    const { store } = createServer()
    const openPayload = await createOpenCredential()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], wrongPayer), openPayload.channelId),
    ).rejects.toThrow(/tx sender .* is not the channel payee/)
  })

  test('rejects unsupported precompile settle fee payer options', async () => {
    const { store } = createServer()
    const openPayload = await createOpenCredential()
    await persistPrecompileChannel(store, openPayload)

    const { settle } = await import('./Session.js')
    await expect(
      settle(store, createServerClient([], payer), openPayload.channelId, {
        feePayer: wrongPayer,
      } as never),
    ).rejects.toThrow(/does not support feePayer or feeToken/)
  })

  test('accepts settle account override matching the channel payee', async () => {
    const { store } = createServer()
    const openPayload = await createOpenCredential()
    await persistPrecompileChannel(store, openPayload, { payee: wrongPayer.address })
    const calls: RpcCall[] = []
    const client = createClient({
      account: payer,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          calls.push(args)
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
})
