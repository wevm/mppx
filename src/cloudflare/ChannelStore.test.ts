import { afterEach, describe, expect, test, vi } from 'vp/test'

import { BadRequestError, VerificationFailedError } from '../Errors.js'
import * as Store from '../Store.js'
import type { State } from '../tempo/session/server/ChannelStore.js'
import { settle } from './Channels.js'
import { ChannelStore, settlementDue, unsettledAmount } from './ChannelStore.js'

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

  test('keeps its lease while a settlement outlasts it', async () => {
    vi.useFakeTimers()
    try {
      const store = Store.memory()
      await store.put(channelId, channel())
      let calls = 0
      const second = message()
      await settle(
        { messages: [message().message] },
        {
          getClient: () => ({}) as never,
          async settle() {
            calls++
            // The first settlement waits past the 5-minute lease for its receipt.
            await vi.advanceTimersByTimeAsync(6 * 60_000)
            await settle(
              { messages: [second.message] },
              {
                getClient: () => ({}) as never,
                async settle() {
                  calls++
                  return '0x1234'
                },
                store,
              },
            )
            return '0x1234'
          },
          store,
        },
      )
      expect({ calls, ...second.outcome }).toEqual({ calls: 1, delaySeconds: 60 })
      expect(((await store.get(channelId)) as State).scheduledSettlementLease).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test("leaves a channel the server's own cooperative close captures until that close expires", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000))
    expect(await run(channel({ closeRequestedAt: now, pendingCloseAt: now }))).toEqual({
      calls: 0,
      delaySeconds: 60,
    })
    // An expired marker means the close can no longer land.
    const expired = now - 120n
    expect(await run(channel({ closeRequestedAt: expired, pendingCloseAt: expired }))).toEqual({
      acked: true,
      calls: 1,
    })
  })

  test('retries any other failure with backoff', async () => {
    expect(await run(channel(), new Error('rpc unavailable'))).toEqual({
      calls: 1,
      delaySeconds: 60,
    })
  })
})

describe('ChannelStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A channel object on in-memory storage whose alarm a test fires by hand. */
  function object(settlement: Partial<ChannelStore.Settlement> = {}) {
    const map = new Map<string, unknown>()
    const sent: ChannelStore.Message[] = []
    let alarm: number | null = null
    class TestStore extends ChannelStore {
      protected override settlement(): ChannelStore.Settlement {
        return {
          minUnsettledAmount: 100n,
          queue: {
            async send(body) {
              sent.push(body)
            },
          },
          ...settlement,
        }
      }
    }
    const store = new TestStore({
      storage: {
        get: async (key) => structuredClone(map.get(key)),
        async put(key, value) {
          map.set(key, structuredClone(value))
        },
        delete: async (key) => map.delete(key),
        getAlarm: async () => alarm,
        async setAlarm(time) {
          alarm = Number(time)
        },
      },
    })
    return {
      sent,
      /** Milliseconds until the alarm, or null without one. */
      alarmIn: () => (alarm === null ? null : alarm - Date.now()),
      /** Fires the alarm at its time, as Cloudflare does, moving the clock there if it is later. */
      async fire() {
        if (alarm !== null && alarm > Date.now()) vi.setSystemTime(alarm)
        alarm = null
        await store.alarm()
      },
      write: (state: State) => store.storePut(channelId, state, 'native'),
    }
  }

  test('sends a close request or a threshold of new vouchers at once while the watchdog waits', async () => {
    const channels = object()
    // 10% of the deposit, 1_000, is the threshold.
    await channels.write(channel({ voucher: 2_000n }))
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    // Every job fails, so the watchdog backs off: 5, 10, then 20 minutes.
    for (let sends = 1; sends <= 3; sends++) {
      await channels.fire()
      expect(channels.sent).toHaveLength(sends)
    }
    expect(channels.alarmIn()).toBeGreaterThan(15 * 60_000)
    // Less than a threshold's worth more waits for the watchdog.
    await channels.write(channel({ voucher: 2_500n }))
    expect(channels.alarmIn()).toBeGreaterThan(15 * 60_000)
    // A threshold's worth more than the last send could settle goes at once, and restarts the count.
    await channels.write(channel({ voucher: 3_000n }))
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    await channels.fire()
    expect(channels.sent).toHaveLength(4)
    expect(channels.alarmIn()).toBeGreaterThan(4 * 60_000)
    expect(channels.alarmIn()).toBeLessThanOrEqual(5 * 60_000)
    await channels.write(channel({ voucher: 3_000n }))
    expect(channels.alarmIn()).toBeGreaterThan(4 * 60_000)
    // A close request goes at once, once.
    await channels.write(channel({ voucher: 3_000n, closeRequestedAt: 1n }))
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    await channels.fire()
    expect(channels.sent).toHaveLength(5)
    await channels.write(channel({ voucher: 3_000n, closeRequestedAt: 1n }))
    expect(channels.alarmIn()).toBeGreaterThan(60_000)
    expect(channels.alarmIn()).toBeLessThanOrEqual(2 * 60_000)
  })

  test('keeps the immediate send of a close request written while a send is in flight', async () => {
    let during: (() => Promise<unknown>) | undefined
    const channels = object({
      queue: {
        async send() {
          await during?.()
        },
      },
    })
    await channels.write(channel({ voucher: 2_000n }))
    await channels.fire()
    // The payer requests a close while the next send awaits the queue.
    during = () => channels.write(channel({ voucher: 2_000n, closeRequestedAt: 1n }))
    await channels.fire()
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
  })

  test('keeps the immediate send of a close request written while a send fails', async () => {
    let during: (() => Promise<unknown>) | undefined
    const channels = object({
      queue: {
        async send() {
          await during?.()
          throw new Error('queue unavailable')
        },
      },
    })
    await channels.write(channel({ voucher: 2_000n }))
    during = () => channels.write(channel({ voucher: 2_000n, closeRequestedAt: 1n }))
    await channels.fire()
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
  })

  test('stops resending after maxAttempts with a zero minUnsettledAmount', async () => {
    const channels = object({ minUnsettledAmount: 0n })
    await channels.write(channel({ deposit: 5n, voucher: 2n }))
    await channels.fire()
    expect(channels.sent).toHaveLength(1)
    // A write with no new vouchers, such as a settlement lease, keeps the count and the watchdog.
    await channels.write(channel({ deposit: 5n, voucher: 2n }))
    expect(channels.alarmIn()).toBeGreaterThan(4 * 60_000)
  })

  test('waits out a live close marker instead of giving up, and sends a close request merged into it', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    try {
      const channels = object({ maxAttempts: 1 })
      await channels.write(channel({ voucher: 2_000n }))
      await channels.fire()
      expect(channels.sent).toHaveLength(1)
      // The server marks its close shortly before the last watchdog attempt is due.
      vi.setSystemTime(Date.now() + channels.alarmIn()! - 10_000)
      const marker = BigInt(Math.floor(Date.now() / 1000))
      await channels.write(
        channel({ voucher: 2_000n, closeRequestedAt: marker, pendingCloseAt: marker }),
      )
      expect(channels.alarmIn()).toBeLessThanOrEqual(10_000)
      // That attempt, inside the marker's window, neither sends nor gives up.
      await channels.fire()
      expect(channels.sent).toHaveLength(1)
      expect(channels.alarmIn()).toBeLessThanOrEqual(56_000)
      // Once the marker can no longer land, the payer close request merged into it goes out.
      vi.setSystemTime(Date.now() + channels.alarmIn()!)
      await channels.fire()
      expect(channels.sent).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not spend a watchdog attempt on the alarm of a close marker that was cleared', async () => {
    const channels = object()
    await channels.write(channel({ voucher: 2_000n }))
    await channels.fire()
    expect(channels.sent).toHaveLength(1)
    const marker = BigInt(Math.floor(Date.now() / 1000))
    await channels.write(
      channel({ voucher: 2_000n, closeRequestedAt: marker, pendingCloseAt: marker }),
    )
    expect(channels.alarmIn()).toBeLessThanOrEqual(56_000)
    // The close failed and the marker is cleared; its alarm stays.
    await channels.write(channel({ voucher: 2_000n }))
    await channels.fire()
    expect(channels.sent).toHaveLength(1)
    expect(channels.alarmIn()).toBeGreaterThan(4 * 60_000)
  })

  test('rejects a non-finite staleAfterMs instead of scheduling no alarm', async () => {
    const channels = object({ staleAfterMs: Number.POSITIVE_INFINITY })
    await expect(channels.write(channel({ deposit: 1_000_000n, voucher: 500n }))).rejects.toThrow(
      'staleAfterMs',
    )
  })

  test("resends a closing channel within the escrow's close grace period", async () => {
    const channels = object({ watchdogMs: 20 * 60_000 })
    await channels.write(channel({ voucher: 2_000n, closeRequestedAt: 1n }))
    // Every job fails: each of the six sends follows the last within 2 minutes.
    for (let sends = 1; sends <= 6; sends++) {
      await channels.fire()
      expect(channels.sent).toHaveLength(sends)
      expect(channels.alarmIn()).toBeLessThanOrEqual(2 * 60_000)
    }
  })

  test('sends a channel below the threshold at once when its payer requests a close', async () => {
    const channels = object()
    await channels.write(channel({ deposit: 1_000_000n, voucher: 500n }))
    expect(channels.alarmIn()).toBeGreaterThan(4 * 60_000)
    await channels.write(channel({ deposit: 1_000_000n, voucher: 500n, closeRequestedAt: 1n }))
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    await channels.fire()
    expect(channels.sent).toEqual([{ channelId }])
  })

  test("waits on the server's own cooperative-close marker until that close can no longer land", async () => {
    const channels = object()
    const marker = BigInt(Math.floor(Date.now() / 1000))
    await channels.write(
      channel({
        deposit: 1_000_000n,
        voucher: 500n,
        closeRequestedAt: marker,
        pendingCloseAt: marker,
      }),
    )
    // Not at once, but by the end of the marker's window (validity and clock skew, 55 s).
    expect(channels.alarmIn()).toBeGreaterThan(0)
    expect(channels.alarmIn()).toBeLessThanOrEqual(56_000)
    // A payer's close request after the marker still goes at once.
    await channels.write(
      channel({
        deposit: 1_000_000n,
        voucher: 500n,
        closeRequestedAt: marker + 100n,
        pendingCloseAt: marker,
      }),
    )
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
  })

  test("sends at once a close request merged into the server's expired close marker", async () => {
    const channels = object()
    // On-chain merges keep the greater timestamp, so a payer's earlier request reads as the marker.
    const marker = BigInt(Math.floor(Date.now() / 1000)) - 120n
    await channels.write(
      channel({
        deposit: 1_000_000n,
        voucher: 500n,
        closeRequestedAt: marker,
        pendingCloseAt: marker,
      }),
    )
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    await channels.fire()
    expect(channels.sent).toEqual([{ channelId }])
  })

  test("sends a backed-off channel again once the server's close marker expires", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    try {
      const channels = object()
      await channels.write(channel({ voucher: 2_000n }))
      // Every job fails, so the watchdog backs off past 15 minutes.
      for (let sends = 1; sends <= 3; sends++) {
        await channels.fire()
        expect(channels.sent).toHaveLength(sends)
      }
      expect(channels.alarmIn()).toBeGreaterThan(15 * 60_000)
      // The server marks its close; a payer's close request merged into it stays hidden while it may land.
      const marker = BigInt(Math.floor(Date.now() / 1000))
      await channels.write(
        channel({ voucher: 2_000n, closeRequestedAt: marker, pendingCloseAt: marker }),
      )
      expect(channels.alarmIn()).toBeGreaterThan(0)
      expect(channels.alarmIn()).toBeLessThanOrEqual(56_000)
      // Its close never landed: the alarm at the window's end sends it and restarts the count.
      vi.setSystemTime(Date.now() + channels.alarmIn()!)
      await channels.fire()
      expect(channels.sent).toHaveLength(4)
      expect(channels.alarmIn()).toBeLessThanOrEqual(2 * 60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  test('sends a new close request at once after the one a send covered cleared', async () => {
    const channels = object()
    await channels.write(channel({ voucher: 2_000n, closeRequestedAt: 1n }))
    await channels.fire()
    expect(channels.sent).toHaveLength(1)
    await channels.write(channel({ voucher: 2_000n }))
    expect(channels.alarmIn()).toBeGreaterThan(60_000)
    await channels.write(channel({ voucher: 2_000n, closeRequestedAt: 2n }))
    expect(channels.alarmIn()).toBeLessThanOrEqual(0)
    await channels.fire()
    expect(channels.sent).toHaveLength(2)
  })
})
