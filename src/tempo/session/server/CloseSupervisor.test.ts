import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as Store from '../../../Store.js'
import * as Chain from '../precompile/Chain.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { superviseCloses } from './CloseSupervisor.js'

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044976f5d56aabe9517a7f3146b789fe719a97d0a9b49f',
)
const token = '0x20c0000000000000000000000000000000000001' as Address
const feeToken = '0x20c000000000000000000000b9537d11c60e8b50' as Address
const channelId = `0x${'01'.repeat(32)}` as Hex
const txHash = `0x${'aa'.repeat(32)}` as Hex
const descriptor = {
  authorizedSigner: '0x0000000000000000000000000000000000000004',
  expiringNonceHash: `0x${'22'.repeat(32)}`,
  operator: '0x0000000000000000000000000000000000000000',
  payee: account.address,
  payer: '0x0000000000000000000000000000000000000001',
  salt: `0x${'11'.repeat(32)}`,
  token,
} as const

afterEach(() => {
  vi.restoreAllMocks()
})

function channel(overrides: Partial<ChannelStore.State> = {}): ChannelStore.State {
  return {
    authorizedSigner: descriptor.authorizedSigner,
    backend: 'precompile',
    chainId: 4217,
    channelId,
    closeRequestedAt: 0n,
    createdAt: new Date(0).toISOString(),
    deposit: 1_000n,
    descriptor,
    escrowContract: tip20ChannelEscrow,
    expiringNonceHash: descriptor.expiringNonceHash,
    finalized: false,
    highestVoucher: { channelId, cumulativeAmount: 500n, signature: '0x1234' },
    highestVoucherAmount: 500n,
    operator: descriptor.operator,
    payee: descriptor.payee,
    payer: descriptor.payer,
    salt: descriptor.salt,
    settledOnChain: 100n,
    spent: 350n,
    token,
    units: 3,
    ...overrides,
  } as ChannelStore.State
}

async function seed(overrides: Partial<ChannelStore.State> = {}, id: Hex = channelId) {
  const store = ChannelStore.fromStore(Store.memory())
  await store.updateChannel(id, () => channel({ ...overrides, channelId: id }))
  return store
}

function closedLog(id: Hex, settledToPayee: bigint, refundedToPayer: bigint) {
  return {
    address: tip20ChannelEscrow,
    data: encodeAbiParameters(
      [{ type: 'uint96' }, { type: 'uint96' }],
      [settledToPayee, refundedToPayer],
    ),
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: 'ChannelClosed',
      args: { channelId: id, payer: descriptor.payer, payee: descriptor.payee },
    }),
  }
}

function settledLog(id: Hex, newSettled: bigint, deltaPaid: bigint) {
  return {
    address: tip20ChannelEscrow,
    data: encodeAbiParameters(
      [{ type: 'uint96' }, { type: 'uint96' }, { type: 'uint96' }],
      [newSettled, deltaPaid, newSettled],
    ),
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: 'Settled',
      args: { channelId: id, payer: descriptor.payer, payee: descriptor.payee },
    }),
  }
}

function rpcLog(log: ReturnType<typeof closedLog>, blockNumber: bigint) {
  return {
    ...log,
    blockHash: `0x${'02'.repeat(32)}`,
    blockNumber: numberToHex(blockNumber),
    logIndex: '0x0',
    removed: false,
    transactionHash: txHash,
    transactionIndex: '0x0',
  }
}

function createSupervisorClient(
  options: {
    block?: { number: bigint; timestamp: bigint } | undefined
    logs?: ((range: { fromBlock: bigint; toBlock: bigint }) => unknown[]) | undefined
    requests?: { method: string; params: unknown }[] | undefined
  } = {},
) {
  const block = options.block ?? { number: 1_000n, timestamp: 2_000_000n }
  return createClient({
    account,
    transport: custom(
      {
        async request(args) {
          options.requests?.push({ method: args.method, params: args.params })
          if (args.method === 'eth_getBlockByNumber')
            return {
              baseFeePerGas: '0x1',
              hash: `0x${'03'.repeat(32)}`,
              number: numberToHex(block.number),
              timestamp: numberToHex(block.timestamp),
              transactions: [],
            }
          if (args.method === 'eth_getLogs') {
            const [filter] = args.params as [{ fromBlock: Hex; toBlock: Hex }]
            return (
              options.logs?.({
                fromBlock: BigInt(filter.fromBlock),
                toBlock: BigInt(filter.toBlock),
              }) ?? []
            )
          }
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      },
      { retryCount: 0 },
    ),
  })
}

function mockStates(...states: Chain.ChannelState[]) {
  return vi.spyOn(Chain, 'getChannelStatesBatch').mockResolvedValue(states)
}

describe('superviseCloses', () => {
  test('settles an open channel within spend when its spend crossed the schedule', async () => {
    // A credit left the highest voucher above spent; an earlier retained voucher is within it.
    const store = await seed({
      retainedVouchers: [{ cumulativeAmount: 300n, signature: '0xabcd' }],
    })
    mockStates({ closeRequestedAt: 0, deposit: 1_000n, settled: 100n })
    const settleOnChain = vi.spyOn(Chain, 'settleOnChain').mockResolvedValue(txHash)
    vi.spyOn(Chain, 'waitForSuccessfulReceipt').mockResolvedValue({
      blockNumber: 1_001n,
      logs: [settledLog(channelId, 300n, 200n)],
    } as never)
    vi.spyOn(Chain, 'getChannelState').mockResolvedValue({
      closeRequestedAt: 0,
      deposit: 1_000n,
      settled: 300n,
    })

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      feeToken,
      settlementSchedule: { units: 1 },
      store,
    })

    expect(settleOnChain).toHaveBeenCalledWith(
      expect.anything(),
      descriptor,
      300n,
      '0xabcd',
      tip20ChannelEscrow,
      expect.objectContaining({ account, feeToken }),
    )
    expect(supervision).toMatchObject({
      complete: true,
      settled: 1,
      channels: [{ channelId, outcome: 'settled', txHash }],
    })
    expect(await store.getChannel(channelId)).toMatchObject({
      finalized: false,
      settledOnChain: 300n,
    })
  })

  test('only reads open channels without a settlement schedule', async () => {
    const store = await seed()
    mockStates({ closeRequestedAt: 0, deposit: 1_000n, settled: 100n })
    const settleOnChain = vi.spyOn(Chain, 'settleOnChain')

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(settleOnChain).not.toHaveBeenCalled()
    expect(supervision.channels).toEqual([{ channelId, outcome: 'open' }])
  })

  test('answers a close request with a payee close capturing spent', async () => {
    const store = await seed()
    mockStates({ closeRequestedAt: 1_700, deposit: 1_000n, settled: 100n })
    const closeOnChain = vi.spyOn(Chain, 'closeOnChain').mockResolvedValue(txHash)
    vi.spyOn(Chain, 'waitForSuccessfulReceipt').mockResolvedValue({
      logs: [closedLog(channelId, 350n, 650n)],
    } as never)
    const settlements: { amount: bigint; delta: bigint; trigger: string }[] = []

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      feeToken,
      onSessionSettlement: ({ amount, delta, trigger }) =>
        void settlements.push({ amount, delta, trigger }),
      store,
    })

    expect(closeOnChain).toHaveBeenCalledWith(
      expect.anything(),
      descriptor,
      500n,
      350n,
      '0x1234',
      tip20ChannelEscrow,
      expect.objectContaining({ account, candidateFeeTokens: [token], feeToken }),
    )
    expect(supervision).toMatchObject({
      block: 1_000n,
      timestamp: 2_000_000,
      closed: 1,
      complete: true,
      failed: 0,
      supervised: 1,
      channels: [{ channelId, outcome: 'closed', txHash }],
    })
    expect(settlements).toEqual([{ amount: 350n, delta: 250n, trigger: 'close' }])
    expect(await store.getChannel(channelId)).toMatchObject({
      closeRequestedAt: 0n,
      closeSupervisedFromBlock: 1_000n,
      deposit: 0n,
      finalized: true,
      settledOnChain: 350n,
    })
  })

  test('marks a close request without sending a close when nothing is left to capture', async () => {
    const store = await seed({ settledOnChain: 350n })
    mockStates({ closeRequestedAt: 1_700, deposit: 1_000n, settled: 350n })
    const closeOnChain = vi.spyOn(Chain, 'closeOnChain')

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(closeOnChain).not.toHaveBeenCalled()
    expect(supervision.channels).toEqual([{ channelId, outcome: 'closing' }])
    expect(await store.getChannel(channelId)).toMatchObject({ closeRequestedAt: 1_700n })
  })

  test.each([
    ['closed', 350n],
    ['unrecovered', 100n],
  ] as const)(
    'finalizes a %s channel from the close event of its withdrawn deposit',
    async (outcome, paid) => {
      const store = await seed({ closeSupervisedFromBlock: 200n })
      mockStates({ closeRequestedAt: 0, deposit: 0n, settled: 100n })
      const ranges: { fromBlock: bigint; toBlock: bigint }[] = []

      const supervision = await superviseCloses({
        channelIds: [channelId],
        client: createSupervisorClient({
          logs: (range) => {
            ranges.push(range)
            return range.toBlock >= 900n
              ? [rpcLog(closedLog(channelId, paid, 1_000n - paid), 900n)]
              : []
          },
        }),
        logBlockRange: 300n,
        store,
      })

      expect(ranges).toEqual([
        { fromBlock: 200n, toBlock: 499n },
        { fromBlock: 500n, toBlock: 799n },
        { fromBlock: 800n, toBlock: 1_000n },
      ])
      expect(supervision.channels).toEqual([{ channelId, outcome }])
      expect(supervision[outcome]).toBe(1)
      expect(await store.getChannel(channelId)).toMatchObject({
        deposit: 0n,
        finalized: true,
        settledOnChain: paid > 100n ? paid : 100n,
        spent: 350n,
      })
    },
  )

  test('starts the close-event search at the previous complete supervision', async () => {
    const store = await seed({ closeSupervisedFromBlock: 200n })
    mockStates({ closeRequestedAt: 0, deposit: 0n, settled: 100n })
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = []

    await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient({
        logs: (range) => {
          ranges.push(range)
          return [rpcLog(closedLog(channelId, 350n, 650n), 950n)]
        },
      }),
      previousBlock: 900n,
      store,
    })

    expect(ranges).toEqual([{ fromBlock: 900n, toBlock: 1_000n }])
  })

  test('waits for a channel that no supervision has read open and that reads as unfunded', async () => {
    const store = await seed()
    mockStates({ closeRequestedAt: 0, deposit: 0n, settled: 0n })

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(supervision).toMatchObject({ complete: true, channels: [{ outcome: 'open' }] })
    expect(await store.getChannel(channelId)).toMatchObject({ finalized: false })
  })

  test('fails a supervised channel that left the escrow without a close event', async () => {
    const store = await seed({ closeSupervisedFromBlock: 900n })
    mockStates({ closeRequestedAt: 0, deposit: 0n, settled: 100n })

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(supervision).toMatchObject({ complete: false, failed: 1 })
    expect(await store.getChannel(channelId)).toMatchObject({ finalized: false })
  })

  test.each([
    ['reopens a channel whose close request was cancelled', 1_000n, 'cancelled', 0n],
    ['keeps a server close that may still land', 1_999_990n, 'open', 1_999_990n],
  ] as const)('%s', async (_label, closeRequestedAt, outcome, expected) => {
    const store = await seed({ closeRequestedAt })
    mockStates({ closeRequestedAt: 0, deposit: 1_000n, settled: 100n })

    const supervision = await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(supervision.channels).toEqual([{ channelId, outcome }])
    expect((await store.getChannel(channelId))!.closeRequestedAt).toBe(expected)
  })

  test('records the first block that read a channel open', async () => {
    const store = await seed()
    mockStates({ closeRequestedAt: 0, deposit: 1_000n, settled: 100n })

    await superviseCloses({ channelIds: [channelId], client: createSupervisorClient(), store })
    await superviseCloses({
      channelIds: [channelId],
      client: createSupervisorClient({ block: { number: 2_000n, timestamp: 2_000_500n } }),
      store,
    })

    expect((await store.getChannel(channelId))!.closeSupervisedFromBlock).toBe(1_000n)
  })

  test('reads every channel at the pinned block in batches', async () => {
    const ids = [1, 2, 3].map((index) => `0x${index.toString(16).padStart(64, '0')}` as Hex)
    const store = ChannelStore.fromStore(Store.memory())
    for (const id of ids) await store.updateChannel(id, () => channel({ channelId: id }))
    const states = vi
      .spyOn(Chain, 'getChannelStatesBatch')
      .mockImplementation(async (_client, channelIds) =>
        channelIds.map(() => ({ closeRequestedAt: 0, deposit: 1_000n, settled: 100n })),
      )

    const supervision = await superviseCloses({
      batchSize: 2,
      channelIds: (async function* () {
        yield* ids
      })(),
      client: createSupervisorClient(),
      store,
    })

    expect(
      states.mock.calls.map(([, channelIds, , blockNumber]) => [channelIds, blockNumber]),
    ).toEqual([
      [ids.slice(0, 2), 1_000n],
      [ids.slice(2), 1_000n],
    ])
    expect(supervision).toMatchObject({ complete: true, supervised: 3 })
  })

  test('reports finalized and missing channels and fails a batch whose state read fails', async () => {
    const finalizedId = `0x${'0f'.repeat(32)}` as Hex
    const missingId = `0x${'0e'.repeat(32)}` as Hex
    const store = await seed()
    await store.updateChannel(finalizedId, () =>
      channel({ channelId: finalizedId, finalized: true }),
    )
    vi.spyOn(Chain, 'getChannelStatesBatch').mockRejectedValue(new Error('rpc unavailable'))

    const supervision = await superviseCloses({
      channelIds: [finalizedId, missingId, channelId],
      client: createSupervisorClient(),
      store,
    })

    expect(supervision).toMatchObject({ complete: false, failed: 1, supervised: 3 })
    expect(supervision.channels.map(({ outcome }) => outcome)).toEqual([
      'finalized',
      'missing',
      'failed',
    ])
  })
})
