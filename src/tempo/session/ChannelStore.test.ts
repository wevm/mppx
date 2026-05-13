import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import { chainId, escrowContract as escrowContractDefaults } from '../internal/defaults.js'
import * as PrecompileChannel from '../precompile/Channel.js'
import * as ChannelStore from './ChannelStore.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const channelId2 = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex
const lowerCaseAliasChannelId = `0x${'ab'.repeat(31)}cd` as Hex
const mixedCaseAliasChannelId = lowerCaseAliasChannelId.replace(/[a-f]/g, (character, index) =>
  index % 2 === 0 ? character.toUpperCase() : character,
) as Hex

const precompileDescriptor = {
  payer: '0x0000000000000000000000000000000000000001' as Address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000005' as Address,
  token: '0x0000000000000000000000000000000000000003' as Address,
  salt: `0x${'11'.repeat(32)}` as Hex,
  authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as Hex,
} satisfies PrecompileChannel.ChannelDescriptor

type ContractChannelOverrides = Partial<ChannelStore.BaseState> &
  Partial<ChannelStore.ContractBackendState>
type PrecompileChannelOverrides = Partial<ChannelStore.BaseState> &
  ChannelStore.PrecompileBackendState

type ChannelOverrides = ContractChannelOverrides | PrecompileChannelOverrides

function makeChannel(overrides?: ContractChannelOverrides): ChannelStore.State
function makeChannel(overrides: PrecompileChannelOverrides): ChannelStore.State
function makeChannel(overrides?: ChannelOverrides): ChannelStore.State {
  return {
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    chainId: 42431,
    escrowContract: escrowContractDefaults[chainId.testnet] as Address,
    deposit: 10_000_000n,
    settledOnChain: 0n,
    highestVoucherAmount: 10_000_000n,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    closeRequestedAt: 0n,
    finalized: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as ChannelStore.State
}

function seedChannel(
  store: ChannelStore.ChannelStore,
  overrides?: ChannelOverrides,
): Promise<ChannelStore.State | null> {
  return store.updateChannel(channelId, () => {
    if (!overrides) return makeChannel()
    if (overrides.backend === 'precompile') return makeChannel(overrides)
    return makeChannel(overrides)
  })
}

function stripUpdateMethod(store: Store.Store | Store.AtomicStore): Store.Store {
  return {
    get: store.get.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
  }
}

function delayedStore(delayMs: number): Store.Store {
  const store = new Map<string, unknown>()
  return {
    async get(key) {
      await sleep(delayMs)
      return (store.get(key) ?? null) as any
    },
    async put(key, value) {
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

// ---------- Store.memory ----------

describe('Store.memory', () => {
  test('get returns null for missing key', async () => {
    const s = Store.memory()
    expect(await s.get('missing')).toBeNull()
  })

  test('put then get returns value', async () => {
    const s = Store.memory()
    const ch = makeChannel()
    await s.put('k', ch)
    const result = await s.get('k')
    expect(result).toEqual(ch)
  })

  test('delete removes key', async () => {
    const s = Store.memory()
    await s.put('k', makeChannel())
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })
})

// ---------- channelStore ----------

describe('channelStore', () => {
  describe('getChannel', () => {
    test('returns null for missing channel', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      expect(await cs.getChannel(channelId)).toBeNull()
    })

    test('returns channel after update', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      const ch = makeChannel()
      await cs.updateChannel(channelId, () => ch)

      const loaded = await cs.getChannel(channelId)
      expect(loaded).not.toBeNull()
      expect(loaded!.channelId).toBe(channelId)
      expect(loaded!.deposit).toBe(10_000_000n)
      expect(typeof loaded!.deposit).toBe('bigint')
      expect(typeof loaded!.createdAt).toBe('string')
    })

    test('treats case-variant channelIds as the same record', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await cs.updateChannel(mixedCaseAliasChannelId, () =>
        makeChannel({ channelId: mixedCaseAliasChannelId }),
      )

      const loaded = await cs.getChannel(lowerCaseAliasChannelId)
      expect(loaded).not.toBeNull()
      expect(loaded!.channelId).toBe(lowerCaseAliasChannelId)

      await cs.updateChannel(lowerCaseAliasChannelId, (current) =>
        current ? { ...current, spent: 1_000_000n } : null,
      )

      const aliased = await cs.getChannel(mixedCaseAliasChannelId)
      expect(aliased!.channelId).toBe(lowerCaseAliasChannelId)
      expect(aliased!.spent).toBe(1_000_000n)
    })
  })

  describe('updateChannel', () => {
    test('creates channel from null', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      const result = await cs.updateChannel(channelId, (current) => {
        expect(current).toBeNull()
        return makeChannel()
      })
      expect(result).not.toBeNull()
      expect(result!.deposit).toBe(10_000_000n)
    })

    test('updates existing channel', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs)

      const result = await cs.updateChannel(channelId, (current) => {
        return { ...current!, spent: current!.spent + 1_000_000n, units: current!.units + 1 }
      })
      expect(result!.spent).toBe(1_000_000n)
      expect(result!.units).toBe(1)
    })

    test('returning null deletes channel', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs)

      const result = await cs.updateChannel(channelId, () => null)
      expect(result).toBeNull()
      expect(await cs.getChannel(channelId)).toBeNull()
    })

    test('preserves bigint fields', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
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

    test('keeps existing contract-backed channels compatible when backend fields are absent', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs)

      const loaded = await cs.getChannel(channelId)
      expect(loaded).not.toBeNull()
      expect(ChannelStore.isContractState(loaded!)).toBe(true)
      expect(loaded!.backend).toBeUndefined()
      expect('operator' in loaded!).toBe(false)
      expect('salt' in loaded!).toBe(false)
      expect('expiringNonceHash' in loaded!).toBe(false)
      expect('descriptor' in loaded!).toBe(false)
    })

    test('supports explicit contract-backed channel state', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, { backend: 'contract' })

      const loaded = await cs.getChannel(channelId)
      expect(loaded).not.toBeNull()
      expect(ChannelStore.isContractState(loaded!)).toBe(true)
      expect(loaded!.backend).toBe('contract')
    })

    test('persists precompile descriptor fields without affecting accounting', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, {
        backend: 'precompile',
        operator: precompileDescriptor.operator,
        salt: precompileDescriptor.salt,
        expiringNonceHash: precompileDescriptor.expiringNonceHash,
        descriptor: precompileDescriptor,
      })

      const deducted = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
      expect(deducted.ok).toBe(true)

      const loaded = await cs.getChannel(channelId)
      expect(ChannelStore.isPrecompileState(loaded!)).toBe(true)
      if (!ChannelStore.isPrecompileState(loaded!)) throw new Error('expected precompile channel')
      expect(loaded!.backend).toBe('precompile')
      expect(loaded!.operator).toBe(precompileDescriptor.operator)
      expect(loaded!.salt).toBe(precompileDescriptor.salt)
      expect(loaded!.expiringNonceHash).toBe(precompileDescriptor.expiringNonceHash)
      expect(loaded!.descriptor).toEqual(precompileDescriptor)
      expect(loaded!.spent).toBe(1_000_000n)
      expect(loaded!.units).toBe(1)
    })
  })

  describe('waitForUpdate', () => {
    test('resolves on next updateChannel call', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
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
      const cs = ChannelStore.fromStore(Store.memory())
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
      const cs = ChannelStore.fromStore(Store.memory())
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

    test('resolves on successful deductFromChannel with atomic store.update', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, { highestVoucherAmount: 5_000_000n, spent: 0n })

      let resolved = false
      const waiter = cs.waitForUpdate!(channelId).then(() => {
        resolved = true
      })

      await sleep(10)
      expect(resolved).toBe(false)

      const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
      expect(result.ok).toBe(true)

      await waiter
      expect(resolved).toBe(true)
    })
  })
})

// ---------- ChannelStore.deductFromChannel ----------

describe('ChannelStore.deductFromChannel', () => {
  test('deducts when balance is sufficient', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await seedChannel(cs, { highestVoucherAmount: 5_000_000n, spent: 0n })

    const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(true)
    expect(result.channel.spent).toBe(1_000_000n)
    expect(result.channel.units).toBe(1)
  })

  test('returns ok: false when balance insufficient', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await seedChannel(cs, { highestVoucherAmount: 1_000_000n, spent: 500_000n })

    const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(false)
    expect(result.channel.spent).toBe(500_000n)
  })

  test('throws when channel does not exist', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await expect(ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)).rejects.toThrow(
      'channel not found',
    )
  })

  test('rejects deduction when channel is finalized', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await seedChannel(cs, { highestVoucherAmount: 10_000_000n, spent: 0n, finalized: true })

    const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(false)
    expect(result.channel.spent).toBe(0n)
  })

  test.each([
    { label: 'atomic backend', create: () => ChannelStore.fromStore(Store.memory()) },
    {
      label: 'mutex fallback',
      create: () => ChannelStore.fromStore(stripUpdateMethod(Store.memory())),
    },
  ])('rejects deduction when channel close has been requested ($label)', async ({ create }) => {
    const cs = create()
    await seedChannel(cs, {
      highestVoucherAmount: 10_000_000n,
      spent: 0n,
      closeRequestedAt: 1n,
    })

    const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(false)
    expect(result.channel.closeRequestedAt).toBe(1n)
    expect(result.channel.spent).toBe(0n)
    expect(result.channel.units).toBe(0)
  })

  test('exact balance succeeds', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await seedChannel(cs, { highestVoucherAmount: 1_000_000n, spent: 0n })

    const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(result.ok).toBe(true)
    expect(result.channel.spent).toBe(1_000_000n)
  })

  test('sequential deductions accumulate correctly', async () => {
    const cs = ChannelStore.fromStore(Store.memory())
    await seedChannel(cs, { highestVoucherAmount: 5_000_000n, spent: 0n })

    for (let i = 0; i < 5; i++) {
      const result = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
      expect(result.ok).toBe(true)
      expect(result.channel.spent).toBe(BigInt((i + 1) * 1_000_000))
      expect(result.channel.units).toBe(i + 1)
    }

    const final = await ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)
    expect(final.ok).toBe(false)
  })
})

// ---------- Concurrency ----------

describe('concurrency', () => {
  describe('with update (atomic backend)', () => {
    test('concurrent deductions do not lose updates', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 50
      const results = await Promise.all(
        Array.from({ length: N }, () => ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('concurrent deductions respect balance limit', async () => {
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, { highestVoucherAmount: 3_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)),
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
      const cs = ChannelStore.fromStore(Store.memory())
      await seedChannel(cs, { highestVoucherAmount: 10_000_000n, spent: 0n })
      await cs.updateChannel(channelId2, () =>
        makeChannel({ channelId: channelId2, highestVoucherAmount: 10_000_000n, spent: 0n }),
      )

      const N = 20
      const [results1, results2] = await Promise.all([
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(cs, channelId, 1_000_000n),
          ),
        ),
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(cs, channelId2, 1_000_000n),
          ),
        ),
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
      const cs = ChannelStore.fromStore(stripUpdateMethod(Store.memory()))
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 50
      const results = await Promise.all(
        Array.from({ length: N }, () => ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('concurrent deductions respect balance limit', async () => {
      const cs = ChannelStore.fromStore(stripUpdateMethod(Store.memory()))
      await seedChannel(cs, { highestVoucherAmount: 3_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)),
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
      const s = delayedStore(5)
      const cs = ChannelStore.fromStore(s)
      await seedChannel(cs, { highestVoucherAmount: 100_000_000n, spent: 0n })

      const N = 10
      const results = await Promise.all(
        Array.from({ length: N }, () => ChannelStore.deductFromChannel(cs, channelId, 1_000_000n)),
      )

      const successes = results.filter((r) => r.ok).length
      expect(successes).toBe(N)

      const channel = await cs.getChannel(channelId)
      expect(channel!.spent).toBe(BigInt(N * 1_000_000))
      expect(channel!.units).toBe(N)
    })

    test('mutex does not block different channels', async () => {
      const cs = ChannelStore.fromStore(stripUpdateMethod(Store.memory()))
      await seedChannel(cs, { highestVoucherAmount: 10_000_000n, spent: 0n })
      await cs.updateChannel(channelId2, () =>
        makeChannel({ channelId: channelId2, highestVoucherAmount: 10_000_000n, spent: 0n }),
      )

      const N = 20
      const [results1, results2] = await Promise.all([
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(cs, channelId, 1_000_000n),
          ),
        ),
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(cs, channelId2, 1_000_000n),
          ),
        ),
      ])

      expect(results1.filter((r) => r.ok).length).toBe(10)
      expect(results2.filter((r) => r.ok).length).toBe(10)
    })

    test('mutex releases on callback error', async () => {
      const cs = ChannelStore.fromStore(stripUpdateMethod(Store.memory()))
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

      const atomicCs = ChannelStore.fromStore(Store.memory())
      await atomicCs.updateChannel(channelId, () =>
        makeChannel({ highestVoucherAmount: balance, spent: 0n }),
      )

      const mutexCs = ChannelStore.fromStore(stripUpdateMethod(Store.memory()))
      await mutexCs.updateChannel(channelId, () =>
        makeChannel({ highestVoucherAmount: balance, spent: 0n }),
      )

      const [atomicResults, mutexResults] = await Promise.all([
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(atomicCs, channelId, deduction),
          ),
        ),
        Promise.all(
          Array.from({ length: N }, () =>
            ChannelStore.deductFromChannel(mutexCs, channelId, deduction),
          ),
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
