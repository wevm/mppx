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
  test('claims an activation challenge once', async () => {
    const store = fromStore(Store.memory())

    expect(await store.claimActivation('challenge-1')).toBe(true)
    expect(await store.claimActivation('challenge-1')).toBe(false)
    expect(await store.claimActivation('challenge-2')).toBe(true)
  })

  test('tracks a resolved lookup key activation until committed', async () => {
    const store = fromStore(Store.memory())

    expect(await store.beginActivation('user-1:plan:pro', 'challenge-1')).toEqual({
      status: 'started',
    })
    expect(await store.beginActivation('user-1:plan:pro', 'challenge-2')).toEqual({
      status: 'inFlight',
    })

    expect(await store.commitActivation(createRecord(), 'challenge-2')).toBe(false)
    expect(await store.commitActivation(createRecord(), 'challenge-1')).toBe(true)

    expect((await store.getByKey('user-1:plan:pro'))?.subscriptionId).toBe(subscriptionId)
    expect(await store.beginActivation('user-1:plan:pro', 'challenge-3')).toEqual({
      status: 'started',
    })
  })

  test('replaces a stale activation marker after the timeout', async () => {
    const store = fromStore(Store.memory(), { activationTimeoutMs: 0 })

    expect(await store.beginActivation('user-1:plan:pro', 'challenge-1')).toEqual({
      status: 'started',
    })
    expect(await store.beginActivation('user-1:plan:pro', 'challenge-2')).toEqual({
      status: 'started',
    })
    expect(await store.commitActivation(createRecord(), 'challenge-1')).toBe(false)
    expect(await store.commitActivation(createRecord(), 'challenge-2')).toBe(true)
  })

  test('tracks an in-flight renewal and commits it once', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())

    const started = await store.beginRenewal(subscriptionId, 1, '0xrenewal')
    expect(started.status).toBe('started')
    expect((await store.get(subscriptionId))?.inFlightPeriod).toBe(1)
    expect((await store.get(subscriptionId))?.inFlightReference).toBe('0xrenewal')

    const duplicate = await store.beginRenewal(subscriptionId, 1)
    expect(duplicate.status).toBe('inFlight')

    expect(
      await store.commitRenewal(
        subscriptionId,
        createRecord({
          lastChargedPeriod: 1,
          reference: `0x${'b'.repeat(64)}`,
        }),
        1,
      ),
    ).toBe(true)

    expect(
      await store.commitRenewal(
        'sub_missing',
        createRecord({
          lastChargedPeriod: 2,
          reference: `0x${'c'.repeat(64)}`,
        }),
        2,
      ),
    ).toBe(false)

    const committed = await store.get(subscriptionId)
    expect(committed?.lastChargedPeriod).toBe(1)
    expect(committed?.inFlightPeriod).toBe(undefined)

    const charged = await store.beginRenewal(subscriptionId, 1)
    expect(charged.status).toBe('charged')
  })

  test('clears an in-flight renewal after failure', async () => {
    const store = fromStore(Store.memory())
    await store.put(createRecord())

    await store.beginRenewal(subscriptionId, 1)
    await store.failRenewal(subscriptionId, 1)

    expect((await store.get(subscriptionId))?.inFlightPeriod).toBe(undefined)
    expect((await store.beginRenewal(subscriptionId, 1)).status).toBe('started')
  })
})
