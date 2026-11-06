import { describe, expect, test } from 'vp/test'

import { BadRequestError, VerificationFailedError } from '../Errors.js'
import * as Store from '../Store.js'
import type { State } from '../tempo/session/server/ChannelStore.js'
import { settle } from './Channels.js'
import { settlementDue, unsettledAmount } from './ChannelStore.js'

const channelId = `0x${'1'.repeat(64)}` as const

function channel(overrides: Partial<State> & { voucher?: bigint } = {}): State {
  const { voucher = 2_000n, ...rest } = overrides
  return {
    authorizedSigner: '0x00000000000000000000000000000000000000aa',
    backend: 'precompile',
    chainId: 42431,
    channelId,
    closeRequestedAt: 0n,
    createdAt: new Date(0).toISOString(),
    deposit: 10_000n,
    descriptor: {} as never,
    escrowContract: '0x4d50500000000000000000000000000000000000',
    expiringNonceHash: '0x00',
    finalized: false,
    highestVoucher: { channelId, cumulativeAmount: voucher, signature: '0x01' },
    highestVoucherAmount: voucher,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x00000000000000000000000000000000000000ee',
    payer: '0x00000000000000000000000000000000000000aa',
    salt: '0x00',
    settledOnChain: 0n,
    spent: voucher,
    token: '0x20c0000000000000000000000000000000000000',
    units: 1,
    ...rest,
  } as State
}

describe('settlementDue', () => {
  test('settles at once from max(10% of deposit, minUnsettledAmount)', () => {
    expect(settlementDue(channel({ voucher: 1_000n }), { minUnsettledAmount: 100n })).toBe(
      'threshold',
    )
    expect(settlementDue(channel({ voucher: 999n }), { minUnsettledAmount: 100n })).toBe('stale')
    // The minimum wins over a small deposit's 10%.
    expect(settlementDue(channel({ voucher: 2_000n }), { minUnsettledAmount: 5_000n })).toBe(
      'stale',
    )
    expect(settlementDue(channel({ voucher: 2_000n, deposit: 1_000_000n }))).toBe('stale')
    expect(settlementDue(channel({ voucher: 200_000n, deposit: 1_000_000n }))).toBe('threshold')
  })

  test('counts only what a settlement captures: within spent, above settledOnChain', () => {
    expect(unsettledAmount(channel({ voucher: 2_000n, settledOnChain: 1_500n }))).toBe(500n)
    // A credit left the highest voucher above spent, and no retained voucher fits.
    expect(unsettledAmount(channel({ voucher: 2_000n, spent: 1_000n }))).toBe(0n)
    expect(
      unsettledAmount(
        channel({
          voucher: 2_000n,
          spent: 1_500n,
          retainedVouchers: [{ cumulativeAmount: 1_200n, signature: '0x02' }],
        }),
      ),
    ).toBe(1_200n)
  })

  test('needs nothing for a settled or finalized channel', () => {
    expect(settlementDue(channel({ settledOnChain: 2_000n }))).toBeUndefined()
    expect(settlementDue(channel({ finalized: true }))).toBeUndefined()
    expect(settlementDue(channel({ highestVoucher: null, voucher: 0n }))).toBeUndefined()
  })
})

describe('settle', () => {
  function message() {
    const outcome: { acked?: boolean; delaySeconds?: number | undefined } = {}
    return {
      outcome,
      message: {
        attempts: 2,
        body: { channelId },
        ack: () => {
          outcome.acked = true
        },
        retry: (options?: { delaySeconds?: number }) => {
          outcome.delaySeconds = options?.delaySeconds
        },
      },
    }
  }

  async function run(state: State | null, error?: Error) {
    const store = Store.memory()
    if (state) await store.put(channelId, state)
    const { message: queued, outcome } = message()
    let calls = 0
    await settle(
      { messages: [queued] },
      {
        getClient: () => ({}) as never,
        async settle() {
          calls++
          if (error) throw error
          return '0x1234'
        },
        store,
      },
    )
    return { calls, ...outcome }
  }

  test('settles a channel and acknowledges it', async () => {
    expect(await run(channel())).toEqual({ acked: true, calls: 1 })
  })

  test('acknowledges a channel with nothing left to settle without settling', async () => {
    expect(await run(channel({ settledOnChain: 2_000n }))).toEqual({ acked: true, calls: 0 })
    expect(await run(null)).toEqual({ acked: true, calls: 0 })
  })

  test('acknowledges a settlement that cannot succeed', async () => {
    expect(
      await run(channel(), new VerificationFailedError({ reason: 'no voucher to settle' })),
    ).toEqual({ acked: true, calls: 1 })
  })

  test('retries a rejected settlement, which a fee spike can cause', async () => {
    expect(await run(channel(), new BadRequestError({ reason: 'fee above cap' }))).toEqual({
      calls: 1,
      delaySeconds: 60,
    })
  })

  test('acknowledges malformed jobs and settles the rest of the batch', async () => {
    const store = Store.memory()
    await store.put(channelId, channel())
    const malformed = [null, undefined, {}, { channelId: 1 }].map((body) => ({
      ...message().message,
      body,
    }))
    const { message: queued, outcome } = message()
    let calls = 0
    await settle(
      { messages: [...malformed, queued] },
      {
        getClient: () => ({}) as never,
        async settle() {
          calls++
          return '0x1234'
        },
        store,
      },
    )
    expect({ calls, ...outcome }).toEqual({ acked: true, calls: 1 })
  })

  test('leaves a channel another settlement holds for later, and releases its own lease', async () => {
    const held = channel({
      scheduledSettlementLease: { expiresAt: Date.now() + 60_000, owner: 'x' },
    })
    expect(await run(held)).toEqual({ calls: 0, delaySeconds: 60 })

    const store = Store.memory()
    await store.put(channelId, channel())
    const leases: unknown[] = []
    for (const error of [undefined, new Error('rpc unavailable')]) {
      await settle(
        { messages: [message().message] },
        {
          getClient: () => ({}) as never,
          async settle() {
            leases.push(((await store.get(channelId)) as State).scheduledSettlementLease?.owner)
            if (error) throw error
            return '0x1234'
          },
          store,
        },
      )
      expect(((await store.get(channelId)) as State).scheduledSettlementLease).toBeUndefined()
    }
    expect(leases).toEqual([expect.any(String), expect.any(String)])
  })

  test('retries any other failure with backoff', async () => {
    expect(await run(channel(), new Error('rpc unavailable'))).toEqual({
      calls: 1,
      delaySeconds: 60,
    })
  })
})
