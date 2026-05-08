import { KeyAuthorization } from 'ox/tempo'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Methods from '../Methods.js'
import {
  assertSubscriptionTiming,
  getSubscriptionRpcAllowedCalls,
  getSubscriptionScopes,
  signSubscriptionKeyAuthorization,
  toSubscriptionExpiryDate,
  toSubscriptionExpirySeconds,
  toSubscriptionPeriodSeconds,
  verifySubscriptionKeyAuthorization,
} from './KeyAuthorization.js'
import type { SubscriptionAccessKey } from './Types.js'

const secondsPerDay = 86_400

const rootAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const accessAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000002',
)
const otherAccessAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000003',
)
const accessKey = {
  accessKeyAddress: accessAccount.address,
  keyType: 'secp256k1',
} as const satisfies SubscriptionAccessKey
const currency = '0x20c0000000000000000000000000000000000001'
const recipient = '0x1234567890abcdef1234567890abcdef12345678'
const otherRecipient = '0x2222222222222222222222222222222222222222'
const subscriptionExpires = new Date(
  Math.ceil((Date.now() + 365 * 24 * 60 * 60 * 1_000) / 1_000) * 1_000,
).toISOString()

function parseRequest(
  overrides: Partial<Parameters<typeof Methods.subscription.schema.request.parse>[0]> = {},
) {
  return Methods.subscription.schema.request.parse({
    amount: '10',
    chainId: 4217,
    currency,
    decimals: 6,
    periodCount: '1',
    periodUnit: 'day',
    recipient,
    subscriptionExpires,
    ...overrides,
  })
}

async function createPayload(request = parseRequest()) {
  const keyAuthorization = await signSubscriptionKeyAuthorization({
    accessKey,
    account: rootAccount,
    chainId: 4217,
    request,
  })
  if (!keyAuthorization) throw new Error('expected key authorization')
  return {
    signature: KeyAuthorization.serialize(keyAuthorization),
    type: 'keyAuthorization',
  } as const
}

describe('tempo subscription key authorization', () => {
  test('signs and verifies a scoped key authorization', async () => {
    const request = parseRequest()
    const payload = await createPayload(request)

    const result = verifySubscriptionKeyAuthorization({
      accessKey,
      chainId: 4217,
      payload,
      request,
    })

    expect(result.source.address.toLowerCase()).toBe(rootAccount.address.toLowerCase())
    expect(result.authorization.address.toLowerCase()).toBe(
      accessKey.accessKeyAddress.toLowerCase(),
    )
  })

  test('builds wallet allowed calls from the subscription request', () => {
    const request = parseRequest()

    expect(getSubscriptionScopes(request)).toMatchObject([
      { address: currency, recipients: [recipient] },
      { address: currency, recipients: [recipient] },
    ])
    expect(getSubscriptionRpcAllowedCalls(request)).toMatchObject([
      {
        target: currency,
        selectorRules: [{ recipients: [recipient] }, { recipients: [recipient] }],
      },
    ])
  })

  test('rejects key authorizations that do not match the request', async () => {
    const request = parseRequest()
    const payload = await createPayload(request)

    const cases = [
      {
        request: parseRequest({ amount: '11' }),
        reason: 'keyAuthorization amount mismatch',
      },
      {
        request: parseRequest({ currency: otherRecipient }),
        reason: 'keyAuthorization currency mismatch',
      },
      {
        request: parseRequest({ periodCount: '2' }),
        reason: 'keyAuthorization period mismatch',
      },
      {
        request: parseRequest({ recipient: otherRecipient }),
        reason: 'keyAuthorization recipient mismatch',
      },
    ]

    for (const { reason, request } of cases) {
      expect(() =>
        verifySubscriptionKeyAuthorization({
          accessKey,
          chainId: 4217,
          payload,
          request,
        }),
      ).toThrow(reason)
    }
  })

  test('rejects key authorizations for the wrong access key', async () => {
    const request = parseRequest()
    const payload = await createPayload(request)

    expect(() =>
      verifySubscriptionKeyAuthorization({
        accessKey: {
          accessKeyAddress: otherAccessAccount.address,
          keyType: 'secp256k1',
        },
        chainId: 4217,
        payload,
        request,
      }),
    ).toThrow('keyAuthorization access key mismatch')
  })

  test('requires transferWithMemo authorization', async () => {
    const request = parseRequest()
    const payload = await createPayload(request)
    const authorization = KeyAuthorization.deserialize(payload.signature)
    const transferOnly = KeyAuthorization.serialize({
      ...authorization,
      scopes: authorization.scopes?.slice(0, 1),
    })

    expect(() =>
      verifySubscriptionKeyAuthorization({
        accessKey,
        chainId: 4217,
        payload: { ...payload, signature: transferOnly },
        request,
      }),
    ).toThrow('keyAuthorization must allow transferWithMemo')
  })

  test('rejects subscription periods that cannot be represented by the Tempo client', () => {
    expect(() => toSubscriptionPeriodSeconds({ periodCount: '0', periodUnit: 'day' })).toThrow(
      'periodCount is invalid',
    )
    expect(() =>
      toSubscriptionPeriodSeconds({
        periodCount: String(Math.floor(Number.MAX_SAFE_INTEGER / secondsPerDay) + 1),
        periodUnit: 'day',
      }),
    ).toThrow('subscription period cannot be represented exactly by this Tempo client')
  })

  test('rejects subscription expiries that cannot be represented by Tempo key authorizations', () => {
    expect(() =>
      toSubscriptionExpirySeconds(toSubscriptionExpiryDate('2026-01-01T00:00:00.500Z')),
    ).toThrow('subscriptionExpires must be representable as whole seconds')
  })

  test('requires subscription expiry to outlive the challenge expiry', () => {
    const request = parseRequest({
      subscriptionExpires: '2026-01-01T00:00:00.000Z',
    })

    expect(() =>
      assertSubscriptionTiming({
        challengeExpires: '2026-01-01T00:00:00.000Z',
        request,
      }),
    ).toThrow('subscriptionExpires must be strictly later than challenge expires')
  })
})
