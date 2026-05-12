import { Challenge, Credential } from 'mppx'
import { KeyAuthorization } from 'ox/tempo'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Methods from '../Methods.js'
import { signSubscriptionKeyAuthorization } from '../subscription/KeyAuthorization.js'
import type { SubscriptionAccessKey } from '../subscription/Types.js'
import { subscription } from './Subscription.js'

const chainId = 4217
const currency = '0x20c0000000000000000000000000000000000001'
const recipient = '0x1234567890abcdef1234567890abcdef12345678'
const selectedAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const accessAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000002',
)
const otherRootAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000003',
)
const accessKey = {
  accessKeyAddress: accessAccount.address,
  keyType: 'secp256k1',
} as const satisfies SubscriptionAccessKey

type SubscriptionRequest = ReturnType<typeof Methods.subscription.schema.request.parse>

function secondsFromNow(milliseconds: number) {
  return new Date(Math.ceil((Date.now() + milliseconds) / 1_000) * 1_000).toISOString()
}

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.subscription.schema.request.parse>[0]> = {},
): Challenge.Challenge<SubscriptionRequest, 'subscription', 'tempo'> {
  const request = Methods.subscription.schema.request.parse({
    accessKey,
    amount: '1',
    chainId,
    currency,
    decimals: 6,
    periodCount: '1',
    periodUnit: 'day',
    recipient,
    subscriptionExpires: secondsFromNow(86_400_000),
    ...overrides,
  })
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'subscription',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<SubscriptionRequest, 'subscription', 'tempo'>
}

describe('tempo.subscription client', () => {
  test('uses Tempo testnet as the default subscription chain', async () => {
    const challenge = createChallenge({ chainId: undefined })
    const method = subscription({
      account: selectedAccount,
    })

    const credential = Credential.deserialize(
      await method.createCredential({ challenge, context: {} }),
    )
    const payload = Methods.subscription.schema.credential.payload.parse(credential.payload)
    const authorization = KeyAuthorization.deserialize(payload.signature as `0x${string}`)

    expect(authorization.chainId).toBe(42431n)
  })

  test('can reject subscription expiry from custom request validation', async () => {
    const challenge = createChallenge({
      subscriptionExpires: secondsFromNow(2 * 86_400_000),
    })
    const method = subscription({
      account: selectedAccount,
      validateRequest: (request) => {
        const maxExpiry = Date.now() + 86_400_000
        if (new Date(request.subscriptionExpires).getTime() > maxExpiry) {
          throw new Error('subscription expiry too late')
        }
      },
    })

    await expect(method.createCredential({ challenge, context: {} })).rejects.toThrow(
      'subscription expiry too late',
    )
  })

  test('runs custom request validation before authorizing the access key', async () => {
    const challenge = createChallenge()
    const method = subscription({
      account: selectedAccount,
      validateRequest: () => {
        throw new Error('unexpected subscription request')
      },
    })

    await expect(method.createCredential({ challenge, context: {} })).rejects.toThrow(
      'unexpected subscription request',
    )
  })

  test('rejects key authorizations signed by a different account', async () => {
    const challenge = createChallenge()
    const keyAuthorization = await signSubscriptionKeyAuthorization({
      accessKey,
      account: otherRootAccount,
      chainId,
      request: challenge.request,
    })
    if (!keyAuthorization) throw new Error('expected key authorization')

    const method = subscription({
      account: selectedAccount.address,
      getClient: async () =>
        ({
          request: async () => ({
            keyAuthorization: KeyAuthorization.toRpc(keyAuthorization),
          }),
        }) as never,
    })

    await expect(method.createCredential({ challenge, context: {} })).rejects.toThrow(
      'keyAuthorization signer does not match the selected account',
    )
  })
})
