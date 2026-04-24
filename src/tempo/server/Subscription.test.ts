import { Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type { SubscriptionRecord } from '../subscription/Types.js'
import {
  cancel,
  captureActive,
  completeCapture,
  failCapture,
  revoke,
  subscription,
} from './Subscription.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const activeBillingAnchor = new Date(Date.now() - 1_000).toISOString()
const activeSubscriptionExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()
const identity = { id: 'user-1' } as const
const requestOptions = {
  amount: '10',
  chainId: 4217,
  currency: '0x20c0000000000000000000000000000000000001',
  periodSeconds: '3600',
  recipient: '0x1234567890abcdef1234567890abcdef12345678',
  subscriptionExpires: activeSubscriptionExpires,
} as const
const resource = { id: 'resource:alpha' } as const

function createReceipt(subscriptionId: string, reference = '0xreceipt') {
  return {
    method: 'tempo',
    reference,
    status: 'success',
    subscriptionId,
    timestamp: '2025-01-01T00:00:00.000Z',
  } as const
}

function createRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    amount: '10000000',
    billingAnchor: activeBillingAnchor,
    chainId: 4217,
    currency: '0x20c0000000000000000000000000000000000001',
    identityId: 'user-1',
    lastChargedPeriod: 0,
    periodSeconds: '3600',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    reference: '0xsubscription',
    resourceId: 'resource:alpha',
    subscriptionExpires: activeSubscriptionExpires,
    subscriptionId: 'sub_123',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((value) => {
    resolve = value
  })
  return { promise, resolve }
}

function createHandler(parameters: {
  capture?: Parameters<typeof subscription>[0]['capture']
  resolve?: Parameters<typeof subscription>[0]['resolve']
  store: Store.AtomicStore<Record<string, unknown>>
}) {
  const method = subscription({
    activate: async ({ request, resolution, source }) => ({
      receipt: createReceipt('sub_123', '0xactivate'),
      subscription: createRecord({
        amount: request.amount,
        chainId: request.methodDetails?.chainId,
        currency: request.currency,
        identityId: resolution.identity.id,
        periodSeconds: request.periodSeconds,
        recipient: request.recipient,
        resourceId: resolution.resource.id,
        subscriptionExpires: request.subscriptionExpires,
        timestamp: new Date().toISOString(),
        ...(source ? { externalId: source.address } : {}),
      }),
    }),
    ...requestOptions,
    ...(parameters.capture ? { capture: parameters.capture } : {}),
    resolve: parameters.resolve ?? (async () => ({ identity, resource })),
    store: parameters.store,
  })

  return Mppx.create({ methods: [method], realm, secretKey })['tempo/subscription'](requestOptions)
}

function createRequest() {
  return new Request('https://example.com/resource')
}

describe('tempo.subscription', () => {
  test('concurrent request-time renewals only capture once for the same period', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )

    const release = createDeferred()
    const started = createDeferred()
    let captureCalls = 0
    const handler = createHandler({
      capture: async ({ periodIndex, subscription }) => {
        captureCalls++
        started.resolve()
        await release.promise
        return {
          receipt: createReceipt(subscription.subscriptionId, '0xrenewed'),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: '0xrenewed',
          },
        }
      },
      store,
    })

    const first = handler(createRequest())
    const second = handler(createRequest())
    await started.promise
    release.resolve()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(captureCalls).toBe(1)
    expect(
      [firstResult.status, secondResult.status].filter((status) => status === 200),
    ).toHaveLength(1)
    expect(
      [firstResult.status, secondResult.status].filter((status) => status === 402),
    ).toHaveLength(1)

    const followUp = await handler(createRequest())
    expect(followUp.status).toBe(200)
    if (followUp.status !== 200) throw new Error('expected renewed access')

    const receipt = Receipt.fromResponse(followUp.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xrenewed')

    const saved = await subscriptionStore.get('sub_due')
    expect(saved?.lastChargedPeriod).toBeGreaterThan(0)
    expect(saved?.pendingPeriod).toBeUndefined()
  })

  test('background capture races request-time renewal without double charging', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )

    const release = createDeferred()
    const started = createDeferred()
    const reasons: string[] = []
    const capture = async ({
      periodIndex,
      reason,
      subscription,
    }: {
      periodIndex: number
      reason: 'background' | 'request'
      subscription: SubscriptionRecord
    }) => {
      reasons.push(reason)
      started.resolve()
      await release.promise
      return {
        receipt: createReceipt(subscription.subscriptionId, '0xbackground'),
        subscription: {
          ...subscription,
          lastChargedPeriod: periodIndex,
          reference: '0xbackground',
        },
      }
    }
    const handler = createHandler({ capture, store })

    const background = captureActive({ capture, identity, resource, store })
    await started.promise
    const requestResult = await handler(createRequest())
    release.resolve()

    const backgroundResult = await background
    expect(reasons).toEqual(['background'])
    expect(backgroundResult?.receipt.reference).toBe('0xbackground')
    expect(requestResult.status).toBe(402)

    const followUp = await handler(createRequest())
    expect(followUp.status).toBe(200)
    if (followUp.status !== 200) throw new Error('expected post-background access')

    const receipt = Receipt.fromResponse(followUp.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xbackground')
  })

  test('cancel stays active until its effective time, while revoke blocks immediately', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(createRecord())

    const cancelEffectiveAt = new Date(Date.now() + 60_000).toISOString()
    const canceled = await cancel({ cancelEffectiveAt, store, subscriptionId: 'sub_123' })
    expect(canceled?.cancelEffectiveAt).toBe(cancelEffectiveAt)

    const handler = createHandler({ store })
    const beforeRevocation = await handler(createRequest())
    expect(beforeRevocation.status).toBe(200)

    const revokedAt = new Date().toISOString()
    const revoked = await revoke({ revokedAt, store, subscriptionId: 'sub_123' })
    expect(revoked?.revokedAt).toBe(revokedAt)

    const afterRevocation = await handler(createRequest())
    expect(afterRevocation.status).toBe(402)
  })

  test('activation atomically replaces the previous active subscription', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(
      createRecord({
        pendingPeriod: 2,
        pendingPeriodStartedAt: new Date().toISOString(),
        reference: '0xold',
        subscriptionId: 'sub_old',
      }),
    )

    const replacementTimestamp = new Date().toISOString()
    await subscriptionStore.activate(
      createRecord({
        pendingPeriod: 9,
        pendingPeriodStartedAt: new Date().toISOString(),
        reference: '0xnew',
        subscriptionId: 'sub_new',
        timestamp: replacementTimestamp,
      }),
    )

    const active = await subscriptionStore.getActive(identity.id, resource.id)
    expect(active?.subscriptionId).toBe('sub_new')
    expect(active?.pendingPeriod).toBeUndefined()

    const replaced = await subscriptionStore.get('sub_old')
    expect(replaced?.cancelEffectiveAt).toBe(replacementTimestamp)
    expect(replaced?.pendingPeriod).toBeUndefined()
    expect(replaced?.pendingPeriodStartedAt).toBeUndefined()
  })

  test('completeCapture finalizes a pending request-time renewal', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )

    const handler = createHandler({
      capture: async () => ({
        response: new Response('capture pending', {
          headers: { Location: '/subscriptions/sub_due/capture' },
          status: 202,
        }),
      }),
      store,
    })

    const pending = await handler(createRequest())
    expect(pending.status).toBe('pending')
    if (pending.status !== 'pending') throw new Error('expected pending capture')
    expect(pending.response.status).toBe(202)
    expect(pending.response.headers.get('location')).toBe('/subscriptions/sub_due/capture')

    const claimed = await subscriptionStore.get('sub_due')
    expect(claimed?.pendingPeriod).toBeGreaterThan(0)
    expect(claimed?.lastChargedPeriod).toBe(0)
    if (!claimed?.pendingPeriod) throw new Error('expected claimed capture period')

    await completeCapture({
      periodIndex: claimed.pendingPeriod,
      store,
      subscription: {
        ...claimed,
        lastChargedPeriod: claimed.pendingPeriod,
        reference: '0xcompleted',
      },
    })

    const completed = await subscriptionStore.get('sub_due')
    expect(completed?.pendingPeriod).toBeUndefined()
    expect(completed?.pendingPeriodStartedAt).toBeUndefined()
    expect(completed?.reference).toBe('0xcompleted')

    const followUp = await handler(createRequest())
    expect(followUp.status).toBe(200)
    if (followUp.status !== 200) throw new Error('expected completed capture access')

    const receipt = Receipt.fromResponse(followUp.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xcompleted')
  })

  test('failCapture clears the claim so a later request can retry the period', async () => {
    const store = Store.memory()
    const subscriptionStore = SubscriptionStore.fromStore(store)
    await subscriptionStore.activate(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )

    let captureCalls = 0
    const handler = createHandler({
      capture: async ({ periodIndex, subscription }) => {
        captureCalls++
        if (captureCalls === 1) {
          return { response: new Response('capture pending', { status: 202 }) }
        }
        return {
          receipt: createReceipt(subscription.subscriptionId, '0xretried'),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: '0xretried',
          },
        }
      },
      store,
    })

    const first = await handler(createRequest())
    expect(first.status).toBe('pending')

    const claimed = await subscriptionStore.get('sub_due')
    if (!claimed?.pendingPeriod) throw new Error('expected pending claim')

    await failCapture({ periodIndex: claimed.pendingPeriod, store, subscriptionId: 'sub_due' })

    const cleared = await subscriptionStore.get('sub_due')
    expect(cleared?.pendingPeriod).toBeUndefined()
    expect(cleared?.pendingPeriodStartedAt).toBeUndefined()

    const retried = await handler(createRequest())
    expect(captureCalls).toBe(2)
    expect(retried.status).toBe(200)
    if (retried.status !== 200) throw new Error('expected retry success')

    const receipt = Receipt.fromResponse(retried.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xretried')
  })
})
