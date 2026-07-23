import type { Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import * as SponsorBudget from './SponsorBudget.js'

const sponsor = '0x0000000000000000000000000000000000000001'
const hash1 = `0x${'01'.repeat(32)}` as Hex
const hash2 = `0x${'02'.repeat(32)}` as Hex
const storeKey = `mppx:charge:sponsor-budget:42431:${sponsor}` as const

function memoryStore() {
  return Store.memory() as Parameters<typeof SponsorBudget.reserve>[0]
}

function parameters(overrides: Partial<Parameters<typeof SponsorBudget.reserve>[1]> = {}) {
  return {
    chainId: 42431,
    expiresAt: Date.now() + 10_000,
    fee: 1n,
    getReceipt: async () => {
      throw new Error('not found')
    },
    id: hash1,
    maxReservations: 10,
    maxTotalFee: 1n,
    owner: 'worker-1',
    sponsor,
    transactionHash: hash1,
    waitUntil: Date.now() + 10_000,
    ...overrides,
  } satisfies Parameters<typeof SponsorBudget.reserve>[1]
}

describe('SponsorBudget', () => {
  test('rejects a transaction larger than the aggregate budget', async () => {
    const store = memoryStore()
    await expect(
      SponsorBudget.reserve(store, parameters({ fee: 2n, maxTotalFee: 1n })),
    ).rejects.toThrow('fee exceeds the aggregate sponsor budget')
    expect(await store.get(storeKey)).toBeNull()
  })

  test('retains pending exposure until a receipt is observed', async () => {
    const store = memoryStore()
    let confirmed = false
    const getReceipt = async (hash: Hex) => {
      if (hash === hash1 && confirmed) return {}
      throw new Error('not found')
    }
    const first = await SponsorBudget.reserve(store, parameters({ getReceipt }))
    expect(await SponsorBudget.transition(store, first, 'broadcasting')).toBe(true)
    expect(await SponsorBudget.transition(store, first, 'pending')).toBe(true)

    const second = SponsorBudget.reserve(
      store,
      parameters({
        getReceipt,
        id: hash2,
        owner: 'worker-2',
        transactionHash: hash2,
      }),
    )
    expect(
      await Promise.race([
        second.then(() => 'reserved' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 40)),
      ]),
    ).toBe('waiting')

    confirmed = true
    await expect(second).resolves.toMatchObject({ id: hash2, owner: 'worker-2' })
    const state = await store.get(storeKey)
    expect(Object.keys(state!.reservations)).toEqual([hash2])
  })

  test('fences release and transition by reservation owner', async () => {
    const store = memoryStore()
    const handle = await SponsorBudget.reserve(store, parameters())
    const staleHandle = { ...handle, owner: 'stale-worker' }

    expect(await SponsorBudget.transition(store, staleHandle, 'broadcasting')).toBe(false)
    expect(await SponsorBudget.release(store, staleHandle)).toBe(false)
    expect(await store.get(storeKey)).toMatchObject({
      reservations: {
        [hash1]: {
          owner: 'worker-1',
          phase: 'prepared',
          transactionHash: hash1,
        },
      },
    })

    expect(await SponsorBudget.release(store, handle)).toBe(true)
    expect(await store.get(storeKey)).toBeNull()
  })

  test('caps reservation count independently of fee exposure', async () => {
    const store = memoryStore()
    const first = await SponsorBudget.reserve(
      store,
      parameters({ fee: 0n, maxReservations: 1, maxTotalFee: 100n }),
    )
    const second = SponsorBudget.reserve(
      store,
      parameters({
        fee: 0n,
        id: hash2,
        maxReservations: 1,
        maxTotalFee: 100n,
        owner: 'worker-2',
        transactionHash: hash2,
      }),
    )

    expect(
      await Promise.race([
        second.then(() => 'reserved' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 40)),
      ]),
    ).toBe('waiting')
    await SponsorBudget.release(store, first)
    await expect(second).resolves.toMatchObject({ id: hash2 })
  })
})
