import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import { fromStore } from './Store.js'
import type { SubscriptionRecord } from './Types.js'

const subscriptionId = 'sub_123'

function createRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    amount: '10000000',
    billingAnchor: '2025-01-01T00:00:00.000Z',
    chainId: 4217,
    currency: '0x20c0000000000000000000000000000000000001',
    lastChargedPeriod: 0,
    lookupKey: 'user-1:plan:pro',
    periodCount: '1',
    periodUnit: 'day',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    reference: `0x${'a'.repeat(64)}`,
    subscriptionExpires: '2026-01-01T00:00:00.000Z',
    subscriptionId,
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('tempo subscription store', () => {
  test('rejects a replayed activation challenge', async () => {
    const store = fromStore(Store.memory())

    const first = await store.activate({
      challengeId: 'challenge-1',
      create: async () => ({ subscription: createRecord() }),
      lookupKey: 'user-1:plan:pro',
    })
    expect(first.status).toBe('activated')

    expect(
      await store.activate({
        challengeId: 'challenge-1',
        create: async () => ({ subscription: createRecord() }),
        lookupKey: 'user-1:plan:pro',
      }),
    ).toEqual({ status: 'replayed' })
  })

  test('tracks a resolved lookup key activation until committed', async () => {
    const store = fromStore(Store.memory())
    let finishActivation!: () => void
    const pendingActivation = new Promise<void>((resolve) => {
      finishActivation = resolve
    })

    const first = store.activate({
      challengeId: 'challenge-1',
      create: async () => {
        await pendingActivation
        return { subscription: createRecord() }
      },
      lookupKey: 'user-1:plan:pro',
    })
    expect(
      await store.activate({
        challengeId: 'challenge-2',
        create: async () => ({ subscription: createRecord() }),
        lookupKey: 'user-1:plan:pro',
      }),
    ).toEqual({ status: 'inFlight' })

    finishActivation()
    expect((await first).status).toBe('activated')
    expect((await store.getByKey('user-1:plan:pro'))?.subscriptionId).toBe(subscriptionId)
  })

  test('replaces a stale activation marker after the timeout', async () => {
    const store = fromStore(Store.memory(), { activationTimeoutMs: 0 })
    let finishActivation!: () => void
    const pendingActivation = new Promise<void>((resolve) => {
      finishActivation = resolve
    })

    const first = store.activate({
      challengeId: 'challenge-1',
      create: async () => {
        await pendingActivation
        return { subscription: createRecord({ reference: `0x${'b'.repeat(64)}` }) }
      },
      lookupKey: 'user-1:plan:pro',
    })

    const second = await store.activate({
      challengeId: 'challenge-2',
      create: async () => ({ subscription: createRecord() }),
      lookupKey: 'user-1:plan:pro',
    })
    expect(second.status).toBe('activated')

    finishActivation()
    expect(await first).toEqual({ status: 'claimMismatch' })
  })

  test('clears the activation marker when creation fails', async () => {
    const store = fromStore(Store.memory())

    await expect(
      store.activate({
        challengeId: 'challenge-1',
        create: async () => {
          throw new Error('activation failed')
        },
        lookupKey: 'user-1:plan:pro',
      }),
    ).rejects.toThrow('activation failed')

    const retried = await store.activate({
      challengeId: 'challenge-2',
      create: async () => ({ subscription: createRecord() }),
      lookupKey: 'user-1:plan:pro',
    })
    expect(retried.status).toBe('activated')
  })

  test('tracks an in-flight renewal and commits it once', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())

    const renewed = await store.renew({
      inFlightReference: '0xrenewal',
      periodIndex: 1,
      renew: async ({ inFlightReference, subscription }) => {
        expect(inFlightReference).toBe('0xrenewal')
        return {
          subscription: {
            ...subscription,
            lastChargedPeriod: 1,
            reference: `0x${'b'.repeat(64)}`,
          },
        }
      },
      subscriptionId,
    })
    expect(renewed.status).toBe('renewed')
    expect((await store.get(subscriptionId))?.inFlightPeriod).toBe(undefined)

    expect(
      await store.renew({
        inFlightReference: '0xmissing',
        periodIndex: 2,
        renew: async () => ({ subscription: createRecord() }),
        subscriptionId: 'sub_missing',
      }),
    ).toEqual({ status: 'missing' })

    const committed = await store.get(subscriptionId)
    expect(committed?.lastChargedPeriod).toBe(1)
    expect(committed?.inFlightPeriod).toBe(undefined)

    const charged = await store.renew({
      inFlightReference: '0xrenewal',
      periodIndex: 1,
      renew: async () => ({ subscription: createRecord() }),
      subscriptionId,
    })
    expect(charged.status).toBe('charged')
  })

  test('returns in-flight for a duplicate renewal period', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())
    let finishRenewal!: () => void
    const pendingRenewal = new Promise<void>((resolve) => {
      finishRenewal = resolve
    })

    const first = store.renew({
      inFlightReference: '0xrenewal',
      periodIndex: 1,
      renew: async ({ subscription }) => {
        await pendingRenewal
        return { subscription }
      },
      subscriptionId,
    })

    const duplicate = await store.renew({
      inFlightReference: '0xrenewal',
      periodIndex: 1,
      renew: async ({ subscription }) => ({ subscription }),
      subscriptionId,
    })
    expect(duplicate.status).toBe('inFlight')

    finishRenewal()
    expect((await first).status).toBe('renewed')
  })

  test('replaces a stale in-flight renewal after the timeout', async () => {
    const store = fromStore(Store.memory(), { renewalTimeoutMs: 0 })
    await store.put(createRecord())
    let finishRenewal!: () => void
    const pendingRenewal = new Promise<void>((resolve) => {
      finishRenewal = resolve
    })

    const first = store.renew({
      inFlightReference: '0xfirst',
      periodIndex: 1,
      renew: async ({ subscription }) => {
        await pendingRenewal
        return { subscription }
      },
      subscriptionId,
    })

    const second = await store.renew({
      inFlightReference: '0xsecond',
      periodIndex: 1,
      renew: async ({ subscription }) => ({
        subscription: {
          ...subscription,
          reference: `0x${'b'.repeat(64)}`,
        },
      }),
      subscriptionId,
    })
    expect(second.status).toBe('renewed')

    finishRenewal()
    expect(await first).toEqual({ status: 'claimMismatch' })
  })

  test('clears an in-flight renewal after failure', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())

    await expect(
      store.renew({
        inFlightReference: '0xrenewal',
        periodIndex: 1,
        renew: async () => {
          throw new Error('renewal failed')
        },
        subscriptionId,
      }),
    ).rejects.toThrow('renewal failed')

    expect((await store.get(subscriptionId))?.inFlightPeriod).toBe(undefined)
    expect(
      (
        await store.renew({
          inFlightReference: '0xrenewal',
          periodIndex: 1,
          renew: async ({ subscription }) => ({ subscription }),
          subscriptionId,
        })
      ).status,
    ).toBe('renewed')
  })

  test('preserves cancellation that lands during an in-flight renewal', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())

    const renewed = await store.renew({
      inFlightReference: '0xrenewal',
      periodIndex: 1,
      renew: async ({ subscription }) => {
        await store.put({
          ...subscription,
          canceledAt: '2025-01-02T00:00:00.000Z',
        })
        return {
          subscription: {
            ...subscription,
            lastChargedPeriod: 1,
            reference: `0x${'b'.repeat(64)}`,
          },
        }
      },
      subscriptionId,
    })
    expect(renewed.status).toBe('renewed')

    const committed = await store.get(subscriptionId)
    expect(committed?.canceledAt).toBe('2025-01-02T00:00:00.000Z')
    expect(committed?.lastChargedPeriod).toBe(1)
    expect(committed?.inFlightPeriod).toBe(undefined)
  })
})
