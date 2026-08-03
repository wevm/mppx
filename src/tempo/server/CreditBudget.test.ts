import { Store } from 'mppx'
import { describe, expect, test } from 'vp/test'

import * as CreditBudget from './CreditBudget.js'

const payer = `0x${'11'.repeat(20)}` as const
const currency = `0x${'22'.repeat(20)}` as const
const recipient = `0x${'33'.repeat(20)}` as const
const sender = payer

function parameters(overrides: Record<string, unknown> = {}) {
  const transactionHash = `0x${'44'.repeat(32)}` as const
  return {
    amount: 60n,
    chainId: 4217,
    expiresAt: Date.now() + 60_000,
    getOutcome: async () => 'pending' as const,
    id: transactionHash,
    maxExposure: 100n,
    owner: 'owner-1',
    payer,
    payment: {
      challengeBoundMemo: true,
      challengeId: 'challenge-1',
      currency,
      realm: 'api.example.com',
      sender,
      transactionHash,
      transfers: [{ amount: '60', recipient }],
    },
    scope: 'usd',
    ...overrides,
  }
}

function createStore() {
  return Store.memory() as Store.AtomicStore<CreditBudget.ItemMap>
}

describe('CreditBudget', () => {
  test('falls back to confirmation when pending exposure would exceed the cap', async () => {
    const store = createStore()
    const first = parameters()
    const handle = await CreditBudget.reserve(store, first)
    expect(handle).not.toBeNull()
    await CreditBudget.transition(store, handle!, 'broadcasting')
    await CreditBudget.transition(store, handle!, 'pending')

    const second = await CreditBudget.reserve(
      store,
      parameters({
        amount: 50n,
        id: `0x${'55'.repeat(32)}`,
        owner: 'owner-2',
        payment: {
          ...first.payment,
          transactionHash: `0x${'55'.repeat(32)}`,
        },
      }),
    )

    expect(second).toBeNull()
  })

  test('releases successful charges for reuse', async () => {
    const store = createStore()
    const first = parameters()
    const handle = await CreditBudget.reserve(store, first)
    await CreditBudget.transition(store, handle!, 'pending')

    const second = await CreditBudget.reserve(
      store,
      parameters({
        getOutcome: async () => 'success' as const,
        id: `0x${'55'.repeat(32)}`,
        owner: 'owner-2',
        payment: {
          ...first.payment,
          transactionHash: `0x${'55'.repeat(32)}`,
        },
      }),
    )

    expect(second).not.toBeNull()
    expect((await CreditBudget.getState(store, first))?.debt).toBe('0')
  })

  test('converts reverted optimistic charges into durable debt', async () => {
    const store = createStore()
    const first = parameters()
    const handle = await CreditBudget.reserve(store, first)
    await CreditBudget.transition(store, handle!, 'pending')

    const second = await CreditBudget.reserve(
      store,
      parameters({
        amount: 50n,
        getOutcome: async () => 'failed' as const,
        id: `0x${'55'.repeat(32)}`,
        owner: 'owner-2',
        payment: {
          ...first.payment,
          transactionHash: `0x${'55'.repeat(32)}`,
        },
      }),
    )

    expect(second).toBeNull()
    expect(await CreditBudget.getState(store, first)).toMatchObject({
      debt: '60',
      reservations: {},
    })
  })

  test('isolates exposure by payer', async () => {
    const store = createStore()
    const first = parameters({ amount: 100n })
    const handle = await CreditBudget.reserve(store, first)
    await CreditBudget.transition(store, handle!, 'pending')

    const otherPayer = `0x${'66'.repeat(20)}` as const
    const other = await CreditBudget.reserve(
      store,
      parameters({
        amount: 100n,
        id: `0x${'77'.repeat(32)}`,
        owner: 'owner-2',
        payer: otherPayer,
        payment: {
          ...first.payment,
          sender: otherPayer,
          transactionHash: `0x${'77'.repeat(32)}`,
        },
      }),
    )

    expect(other).not.toBeNull()
  })

  test('atomically admits only one of two charges that exceed the cap together', async () => {
    const store = createStore()
    const first = parameters()
    const second = parameters({
      id: `0x${'55'.repeat(32)}`,
      owner: 'owner-2',
      payment: {
        ...first.payment,
        transactionHash: `0x${'55'.repeat(32)}`,
      },
    })

    const reservations = await Promise.all([
      CreditBudget.reserve(store, first),
      CreditBudget.reserve(store, second),
    ])

    expect(reservations.filter(Boolean)).toHaveLength(1)
  })
})
