import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import {
  type ChannelState,
  type ChannelStorage,
  channelStorage,
  deductFromChannel,
  memoryStorage,
  type Storage,
} from './Storage.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const channelId2 = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex

function makeChannel(overrides?: Partial<ChannelState>): ChannelState {
  return {
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    deposit: 10_000_000n,
    settledOnChain: 0n,
    highestVoucherAmount: 10_000_000n,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    finalized: false,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function seedChannel(
  storage: ChannelStorage,
  overrides?: Partial<ChannelState>,
): Promise<ChannelState | null> {
  return storage.updateChannel(channelId, () => makeChannel(overrides))
}

function stripUpdateMethod(storage: Storage): Storage {
  return {
    get: storage.get.bind(storage),
    set: storage.set.bind(storage),
    delete: storage.delete.bind(storage),
  }
}

function delayedStorage(delayMs: number): Storage {
  const store = new Map<string, ChannelState>()
  return {
    async get(key) {
      await sleep(delayMs)
      return store.get(key) ?? null
    },
    async set(key, value) {
      await sleep(delayMs)
      store.set(key, value)
    },
    async delete(key) {
      await sleep(delayMs)
      store.delete(key)
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- memoryStorage ----------

describe('memoryStorage', () => {
  test('get returns null for missing key', async () => {
    const s = memoryStorage()
    expect(await s.get('missing')).toBeNull()
  })

  test('set then get returns value', async () => {
    const s = memoryStorage()
    const ch = makeChannel()
    await s.set('k', ch)
    expect(await s.get('k')).toEqual(ch)
  })

  test('delete removes key', async () => {
    const s = memoryStorage()
    await s.set('k', makeChannel())
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })

  test('update creates new key', async () => {
    const s = memoryStorage()
    const ch = makeChannel()
    const result = await s.update!('k', () => ch)
    expect(result).toEqual(ch)
    expect(await s.get('k')).toEqual(ch)
  })

  test('update modifies existing key', async () => {
    const s = memoryStorage()
    const ch = makeChannel()
    await s.set('k', ch)
    const result = await s.update!('k', (current) => ({ ...current!, spent: 42n }))
    expect(result!.spent).toBe(42n)
    expect((await s.get('k'))!.spent).toBe(42n)
  })

  test('update returning null deletes key', async () => {
    const s = memoryStorage()
    await s.set('k', makeChannel())
    const result = await s.update!('k', () => null)
    expect(result).toBeNull()
    expect(await s.get('k')).toBeNull()
  })
})

// ---------- channelStorage ----------

describe('channelStorage', () => {
  describe('getChannel', () => {
    test('returns null for missing channel', async () => {
      const cs = channelStorage(memoryStorage())
      expect(await cs.getChannel(channelId)).toBeNull()
    })

    test('returns channel after update', async () => {
      const cs = channelStorage(memoryStorage())
      const ch = makeChannel()
      await cs.updateChannel(channelId, () => ch)

      const loaded = await cs.getChannel(channelId)
      expect(loaded).not.toBeNull()
      expect(loaded!.channelId).toBe(channelId)
      expect(loaded!.deposit).toBe(10_000_000n)
      expect(typeof loaded!.deposit).toBe('bigint')
      expect(loaded!.createdAt).toBeInstanceOf(Date)
    })
  })

  describe('updateChannel', () => {
    test('creates channel from null', async () => {
      const cs = channelStorage(memoryStorage())
      const result = await cs.updateChannel(channelId, (current) => {
        expect(current).toBeNull()
        return makeChannel()
      })
      expect(result).not.toBeNull()
      expect(result!.deposit).toBe(10_000_000n)
    })

    test('updates existing channel', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs)

      const result = await cs.updateChannel(channelId, (current) => {
        return { ...current!, spent: current!.spent + 1_000_000n, units: current!.units + 1 }
      })
      expect(result!.spent).toBe(1_000_000n)
      expect(result!.units).toBe(1)
    })

    test('returning null deletes channel', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs)

      const result = await cs.updateChannel(channelId, () => null)
      expect(result).toBeNull()
      expect(await cs.getChannel(channelId)).toBeNull()
    })

    test('preserves bigint fields', async () => {
      const cs = channelStorage(memoryStorage())
      const ch = makeChannel({
        deposit: 999_999_999_999_999_999n,
        settledOnChain: 123_456_789n,
        highestVoucherAmount: 888_888_888n,
        spent: 42n,
      })
      await cs.updateChannel(channelId, () => ch)

      const loaded = await cs.getChannel(channelId)
      expect(loaded!.deposit).toBe(999_999_999_999_999_999n)
      expect(loaded!.settledOnChain).toBe(123_456_789n)
      expect(loaded!.highestVoucherAmount).toBe(888_888_888n)
      expect(loaded!.spent).toBe(42n)
    })

    test('preserves Date fields', async () => {
      const cs = channelStorage(memoryStorage())
      const date = new Date('2025-06-15T12:30:00.000Z')
      await cs.updateChannel(channelId, () => makeChannel({ createdAt: date }))

      const loaded = await cs.getChannel(channelId)
      expect(loaded!.createdAt.toISOString()).toBe(date.toISOString())
    })
  })

  describe('waitForUpdate', () => {
    test('resolves on next updateChannel call', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs)

      let resolved = false
      const waiter = cs.waitForUpdate!(channelId).then(() => {
        resolved = true
      })

      await sleep(10)
      expect(resolved).toBe(false)

      await cs.updateChannel(channelId, (c) => (c ? { ...c, spent: 1n } : null))
      await waiter
      expect(resolved).toBe(true)
    })

    test('multiple waiters all resolve', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs)

      let count = 0
      const w1 = cs.waitForUpdate!(channelId).then(() => count++)
      const w2 = cs.waitForUpdate!(channelId).then(() => count++)
      const w3 = cs.waitForUpdate!(channelId).then(() => count++)

      await cs.updateChannel(channelId, (c) => (c ? { ...c, spent: 1n } : null))
      await Promise.all([w1, w2, w3])
      expect(count).toBe(3)
    })

    test('different channels are independent', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs)
      await cs.updateChannel(channelId2, () => makeChannel({ channelId: channelId2 }))

      let ch1Resolved = false
      cs.waitForUpdate!(channelId).then(() => {
        ch1Resolved = true
      })

      await cs.updateChannel(channelId2, (c) => (c ? { ...c, spent: 1n } : null))
      await sleep(10)
      expect(ch1Resolved).toBe(false)
    })
  })
})

// ---------- deductFromChannel ----------

describe('deductFromChannel', () => {
  test('deducts when balance is sufficient', async () => {
    const cs = channelStorage(memoryStorage())
    await seedChannel(cs, { highestVoucherAmount: 5_000_000n, spent: 0n })

    const result = await deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(true)
    expect(result.channel.spent).toBe(1_000_000n)
    expect(result.channel.units).toBe(1)
  })

  test('returns ok: false when balance insufficient', async () => {
    const cs = channelStorage(memoryStorage())
    await seedChannel(cs, { highestVoucherAmount: 1_000_000n, spent: 500_000n })

    const result = await deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(false)
    expect(result.channel.spent).toBe(500_000n)
  })

  test('throws when channel does not exist', async () => {
    const cs = channelStorage(memoryStorage())
    await expect(deductFromChannel(cs, channelId, 1_000_000n)).rejects.toThrow('channel not found')
  })

  test('exact balance succeeds', async () => {
    const cs = channelStorage(memoryStorage())
    await seedChannel(cs, { highestVoucherAmount: 1_000_000n, spent: 0n })

    const result = await deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(true)
    expect(result.channel.spent).toBe(1_000_000n)
  })

  test('sequential deductions accumulate correctly', async () => {
    const cs = channelStorage(memoryStorage())
    await seedChannel(cs, { highestVoucherAmount: 5_000_000n, spent: 0n })

    for (let i = 0; i < 5; i++) {
      const result = await deductFromChannel(cs, channelId, 1_000_000n)
      expect(result.ok).toBe(true)
      expect(result.channel.spent).toBe(BigInt((i + 1) * 1_000_000))
      expect(result.channel.units).toBe(i + 1)
    }

    const final = await deductFromChannel(cs, channelId, 1_000_000n)
    expect(final.ok).toBe(false)
  })
})

// ---------- Concurrency ----------

describe('concurrency', () => {
  describe('with update (atomic backend)', () => {
    test('concurrent deductions do not lose updates', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 50
      const results = await Promise.all(
        Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('concurrent deductions respect balance limit', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs, { highestVoucherAmount: 3_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      const failures = results.filter((r) => !r.ok).length
      expect(successes).toBe(3)
      expect(failures).toBe(7)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(3_000_000n)
      expect(channel!.units).toBe(3)
    })

    test('concurrent updates to different channels are independent', async () => {
      const cs = channelStorage(memoryStorage())
      await seedChannel(cs, { highestVoucherAmount: 10_000_000n, spent: 0n })
      await cs.updateChannel(channelId2, () =>
        makeChannel({ channelId: channelId2, highestVoucherAmount: 10_000_000n, spent: 0n }),
      )

      const N = 20
      const [results1, results2] = await Promise.all([
        Promise.all(Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n))),
        Promise.all(Array.from({ length: N }, () => deductFromChannel(cs, channelId2, 1_000_000n))),
      ])

      expect(results1.filter((r) => r.ok).length).toBe(10)
      expect(results2.filter((r) => r.ok).length).toBe(10)

      const ch1 = await cs.getChannel(channelId)
      const ch2 = await cs.getChannel(channelId2)
      expect(ch1!.spent).toBe(10_000_000n)
      expect(ch2!.spent).toBe(10_000_000n)
    })
  })

  describe('with mutex fallback (no update method)', () => {
    test('concurrent deductions do not lose updates', async () => {
      const cs = channelStorage(stripUpdateMethod(memoryStorage()))
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 50
      const results = await Promise.all(
        Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('concurrent deductions respect balance limit', async () => {
      const cs = channelStorage(stripUpdateMethod(memoryStorage()))
      await seedChannel(cs, { highestVoucherAmount: 3_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      const failures = results.filter((r) => !r.ok).length
      expect(successes).toBe(3)
      expect(failures).toBe(7)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(3_000_000n)
      expect(channel!.units).toBe(3)
    })

    test('mutex serializes async operations', async () => {
      const s = delayedStorage(5)
      const cs = channelStorage(s)
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('mutex does not block different channels', async () => {
      const cs = channelStorage(stripUpdateMethod(memoryStorage()))
      await seedChannel(cs, { highestVoucherAmount: 10_000_000n, spent: 0n })
      await cs.updateChannel(channelId2, () =>
        makeChannel({ channelId: channelId2, highestVoucherAmount: 10_000_000n, spent: 0n }),
      )

      const N = 20
      const [results1, results2] = await Promise.all([
        Promise.all(Array.from({ length: N }, () => deductFromChannel(cs, channelId, 1_000_000n))),
        Promise.all(Array.from({ length: N }, () => deductFromChannel(cs, channelId2, 1_000_000n))),
      ])

      expect(results1.filter((r) => r.ok).length).toBe(10)
      expect(results2.filter((r) => r.ok).length).toBe(10)
    })

    test('mutex releases on callback error', async () => {
      const cs = channelStorage(stripUpdateMethod(memoryStorage()))
      await seedChannel(cs)

      await expect(
        cs.updateChannel(channelId, () => {
          throw new Error('callback error')
        }),
      ).rejects.toThrow('callback error')

      const result = await cs.updateChannel(channelId, (c) => (c ? { ...c, spent: 1n } : null))
      expect(result!.spent).toBe(1n)
    })
  })

  describe('parity: atomic vs mutex produce same results', () => {
    test('same final state after N concurrent deductions', async () => {
      const N = 30
      const balance = 20_000_000n
      const deduction = 1_000_000n

      const atomicCs = channelStorage(memoryStorage())
      await atomicCs.updateChannel(channelId, () =>
        makeChannel({ highestVoucherAmount: balance, spent: 0n }),
      )

      const mutexCs = channelStorage(stripUpdateMethod(memoryStorage()))
      await mutexCs.updateChannel(channelId, () =>
        makeChannel({ highestVoucherAmount: balance, spent: 0n }),
      )

      const [atomicResults, mutexResults] = await Promise.all([
        Promise.all(
          Array.from({ length: N }, () => deductFromChannel(atomicCs, channelId, deduction)),
        ),
        Promise.all(
          Array.from({ length: N }, () => deductFromChannel(mutexCs, channelId, deduction)),
        ),
      ])

      const atomicSuccesses = atomicResults.filter((r) => r.ok).length
      const mutexSuccesses = mutexResults.filter((r) => r.ok).length
      expect(atomicSuccesses).toBe(mutexSuccesses)
      expect(atomicSuccesses).toBe(20)

      const atomicChannel = await atomicCs.getChannel(channelId)
      const mutexChannel = await mutexCs.getChannel(channelId)
      expect(atomicChannel!.spent).toBe(mutexChannel!.spent)
      expect(atomicChannel!.units).toBe(mutexChannel!.units)
      expect(atomicChannel!.spent).toBe(balance)
    })
  })
})
