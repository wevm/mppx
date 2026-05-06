import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { KeyAuthorization } from 'ox/tempo'
import { createClient, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempo_chain } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import * as Methods from '../Methods.js'
import { signSubscriptionKeyAuthorization } from '../subscription/KeyAuthorization.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type { SubscriptionAccessKey } from '../subscription/Types.js'
import type { SubscriptionRecord } from '../subscription/Types.js'
import { renew, subscription } from './Subscription.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const activeBillingAnchor = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString()
const activeSubscriptionExpires = new Date(
  Math.ceil((Date.now() + 365 * 24 * 60 * 60 * 1_000) / 1_000) * 1_000,
).toISOString()
const chainId = 4217
const subscriptionDefaultChainId = 42431
const subscriptionAmount = '10'
const subscriptionCurrency = '0x20c0000000000000000000000000000000000001'
const subscriptionKey = 'user-1:plan:pro'
const subscriptionPeriodCount = '1'
const subscriptionPeriodUnit = 'day'
const subscriptionPeriodMilliseconds = 86_400_000
const subscriptionRecipient = '0x1234567890abcdef1234567890abcdef12345678'
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
const hashActivate = `0x${'a'.repeat(64)}`
const hashRenewed = `0x${'b'.repeat(64)}`
const hashStale = `0x${'c'.repeat(64)}`
const hashBackground = `0x${'d'.repeat(64)}`
const hashOld = `0x${'e'.repeat(64)}`

function createReceipt(subscriptionId: string, reference = hashActivate) {
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
    chainId,
    currency: subscriptionCurrency,
    lastChargedPeriod: 0,
    lookupKey: subscriptionKey,
    periodCount: subscriptionPeriodCount,
    periodUnit: subscriptionPeriodUnit,
    recipient: subscriptionRecipient,
    reference: hashActivate,
    subscriptionExpires: activeSubscriptionExpires,
    subscriptionId: 'sub_123',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function createCredential(
  challenge: Challenge.Challenge,
  source = rootAccount.address,
  key: SubscriptionAccessKey = accessKey,
) {
  const keyAuthorization = await signSubscriptionKeyAuthorization({
    accessKey: key,
    account: rootAccount,
    chainId,
    request: challenge.request as ReturnType<typeof Methods.subscription.schema.request.parse>,
  })
  if (!keyAuthorization) throw new Error('expected key authorization')
  return Credential.from({
    challenge,
    payload: {
      signature: KeyAuthorization.serialize(keyAuthorization),
      type: 'keyAuthorization',
    },
    source: `did:pkh:eip155:${chainId}:${source.toLowerCase()}`,
  })
}

function createBillingClient(hashes: readonly string[]) {
  const rpcMethods: string[] = []
  let nextHash = 0
  const client = createClient({
    chain: { ...tempo_chain, id: chainId },
    transport: custom({
      async request({ method }) {
        rpcMethods.push(method)
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (method === 'eth_call') return '0x'
        if (method === 'eth_sendRawTransaction') return hashes[nextHash++] ?? hashActivate
        throw new Error(`unexpected rpc method: ${method}`)
      },
    }),
  })
  return { client, rpcMethods }
}

describe('tempo.subscription', () => {
  test('stores an activated subscription and reuses it on later requests', async () => {
    const store = Store.memory()
    let activationCount = 0
    const method = subscription({
      activate: async ({ request, resolved }) => {
        activationCount += 1
        return {
          receipt: createReceipt('sub_123', hashActivate),
          subscription: createRecord({
            amount: request.amount,
            chainId: request.methodDetails?.chainId,
            currency: request.currency,
            lookupKey: resolved.key,
            periodCount: request.periodCount,
            periodUnit: request.periodUnit,
            recipient: request.recipient,
            reference: hashActivate,
            subscriptionExpires: request.subscriptionExpires,
          }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async ({ input }) => {
        const key = input.headers.get('X-Subscription-Key')
        return key ? { accessKey, key } : null
      },
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { 'X-Subscription-Key': subscriptionKey },
      }),
    )

    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const challengeRequest = challenge.request as ReturnType<
      typeof Methods.subscription.schema.request.parse
    >
    expect(challengeRequest.methodDetails?.accessKey).toEqual({
      ...accessKey,
      accessKeyAddress: accessKey.accessKeyAddress.toLowerCase(),
    })
    const credential = await createCredential(challenge)

    const activated = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: {
          Authorization: Credential.serialize(credential),
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )

    expect(activated.status).toBe(200)
    expect(activationCount).toBe(1)

    const replayed = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: {
          Authorization: Credential.serialize(credential),
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )

    expect(replayed.status).toBe(402)
    expect(activationCount).toBe(1)

    const reused = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: {
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )

    expect(reused.status).toBe(200)
    if (reused.status !== 200) throw new Error('expected authorize reuse')

    const response = reused.withReceipt(new Response('OK'))
    const receipt = response.headers.get('Payment-Receipt')
    expect(receipt).toBeTruthy()
  })

  test('automatically creates an access key and submits the activation payment', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const { client, rpcMethods } = createBillingClient([hashActivate])
    const method = subscription({
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      getClient: async () => client,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
      waitForConfirmation: false,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const challengeRequest = challenge.request as ReturnType<
      typeof Methods.subscription.schema.request.parse
    >
    const generatedAccessKey = challengeRequest.methodDetails?.accessKey
    expect(generatedAccessKey?.keyType).toBe('secp256k1')
    if (!generatedAccessKey) throw new Error('expected generated access key')

    const credential = await createCredential(challenge, rootAccount.address, generatedAccessKey)
    const activated = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(activated.status).toBe(200)
    if (activated.status !== 200) throw new Error('expected activation')
    const receipt = Receipt.fromResponse(activated.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe(hashActivate)
    expect(receipt.subscriptionId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(rpcMethods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1)

    const record = await subscriptions.getByKey(subscriptionKey)
    expect(record?.accessKey).toEqual(generatedAccessKey)
    expect(record?.keyAuthorization).toBe(credential.payload.signature)
    expect(record?.payer?.address.toLowerCase()).toBe(rootAccount.address.toLowerCase())
    expect(record?.lastChargedPeriod).toBe(0)

    const reused = await mppx.tempo.subscription({})(new Request('https://example.com/resource'))
    expect(reused.status).toBe(200)
    expect(rpcMethods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(1)
  })

  test('automatically renews overdue subscriptions on the request path', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const { client, rpcMethods } = createBillingClient([hashActivate, hashRenewed])
    const method = subscription({
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      getClient: async () => client,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
      waitForConfirmation: false,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')
    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const accessKey = (
      challenge.request as ReturnType<typeof Methods.subscription.schema.request.parse>
    ).methodDetails?.accessKey
    if (!accessKey) throw new Error('expected generated access key')
    const credential = await createCredential(challenge, rootAccount.address, accessKey)
    const activated = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(activated.status).toBe(200)

    const record = await subscriptions.getByKey(subscriptionKey)
    if (!record) throw new Error('expected subscription record')
    await subscriptions.put({
      ...record,
      billingAnchor: new Date(Date.now() - 3 * subscriptionPeriodMilliseconds).toISOString(),
      lastChargedPeriod: 0,
      reference: hashStale,
    })

    const renewed = await mppx.tempo.subscription({})(new Request('https://example.com/resource'))
    expect(renewed.status).toBe(200)
    if (renewed.status !== 200) throw new Error('expected renewal')

    const receipt = Receipt.fromResponse(renewed.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe(hashRenewed)
    expect(rpcMethods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2)
    expect((await subscriptions.get(record.subscriptionId))?.lastChargedPeriod).toBeGreaterThan(0)
  })

  test('requires an access key before issuing a subscription challenge', async () => {
    const method = subscription({
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store: Store.memory(),
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })

    await expect(
      mppx.tempo.subscription({})(new Request('https://example.com/resource')),
    ).rejects.toThrow('subscription accessKey is missing')
  })

  test('defaults omitted subscription chainId to Tempo testnet', async () => {
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: subscriptionAmount,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store: Store.memory(),
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const challengeRequest = challenge.request as ReturnType<
      typeof Methods.subscription.schema.request.parse
    >
    expect(challengeRequest.methodDetails?.chainId).toBe(subscriptionDefaultChainId)
  })

  test('reuses a stored active subscription access key without a resolver callback', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    await subscriptions.put(createRecord({ accessKey, lookupKey: subscriptionKey }))
    const method = subscription({
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })

    const reused = await mppx.tempo.subscription({})(new Request('https://example.com/resource'))

    expect(reused.status).toBe(200)
  })

  test('serializes concurrent fresh activations for the same lookup key', async () => {
    const store = Store.memory()
    let activationCount = 0
    let releaseActivation!: () => void
    let markActivationStarted!: () => void
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve
    })
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => {
        activationCount += 1
        markActivationStarted()
        await activationReleased
        return {
          receipt: createReceipt('sub_123', hashActivate),
          subscription: createRecord({
            amount: request.amount,
            chainId: request.methodDetails?.chainId,
            currency: request.currency,
            lookupKey: resolved.key,
            periodCount: request.periodCount,
            periodUnit: request.periodUnit,
            recipient: request.recipient,
            reference: hashActivate,
            subscriptionExpires: request.subscriptionExpires,
          }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const firstChallengeResult = await mppx.tempo.subscription({
      expires: '2027-01-01T00:01:00.000Z',
    })(new Request('https://example.com/resource'))
    const secondChallengeResult = await mppx.tempo.subscription({
      expires: '2027-01-01T00:02:00.000Z',
    })(new Request('https://example.com/resource'))
    if (firstChallengeResult.status !== 402 || secondChallengeResult.status !== 402) {
      throw new Error('expected activation challenges')
    }

    const firstChallenge = Challenge.fromResponse(firstChallengeResult.challenge)
    const secondChallenge = Challenge.fromResponse(secondChallengeResult.challenge)
    expect(firstChallenge.id).not.toBe(secondChallenge.id)

    const firstCredential = await createCredential(firstChallenge)
    const secondCredential = await createCredential(secondChallenge)
    const firstActivation = mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(firstCredential) },
      }),
    )
    await activationStarted

    const secondActivation = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(secondCredential) },
      }),
    )
    releaseActivation()
    const activated = await firstActivation

    expect(activated.status).toBe(200)
    expect(secondActivation.status).toBe(402)
    expect(activationCount).toBe(1)
  })

  test('allows retry after a stale failed activation attempt', async () => {
    const store = Store.memory()
    let activationCount = 0
    const method = subscription({
      accessKey: async () => accessKey,
      activationTimeoutMs: 0,
      activate: async ({ request, resolved }) => {
        activationCount += 1
        if (activationCount === 1) throw new Error('activation failed before charge')
        return {
          receipt: createReceipt('sub_123', hashActivate),
          subscription: createRecord({
            amount: request.amount,
            chainId: request.methodDetails?.chainId,
            currency: request.currency,
            lookupKey: resolved.key,
            periodCount: request.periodCount,
            periodUnit: request.periodUnit,
            recipient: request.recipient,
            reference: hashActivate,
            subscriptionExpires: request.subscriptionExpires,
          }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const firstChallengeResult = await mppx.tempo.subscription({
      expires: '2027-01-01T00:03:00.000Z',
    })(new Request('https://example.com/resource'))
    const secondChallengeResult = await mppx.tempo.subscription({
      expires: '2027-01-01T00:04:00.000Z',
    })(new Request('https://example.com/resource'))
    if (firstChallengeResult.status !== 402 || secondChallengeResult.status !== 402) {
      throw new Error('expected activation challenges')
    }

    const firstCredential = await createCredential(
      Challenge.fromResponse(firstChallengeResult.challenge),
    )
    const firstRejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(firstCredential) },
      }),
    )
    expect(firstRejected.status).toBe(402)

    const secondCredential = await createCredential(
      Challenge.fromResponse(secondChallengeResult.challenge),
    )
    const retried = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(secondCredential) },
      }),
    )

    expect(retried.status).toBe(200)
    expect(activationCount).toBe(2)
  })

  test('new activation replaces the previous subscription for the same lookup key', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)

    // Seed an expired subscription so authorize() falls through to a new challenge.
    const expiredDate = new Date(Date.now() - 1_000).toISOString()
    await subscriptions.put(
      createRecord({
        lookupKey: subscriptionKey,
        subscriptionId: 'sub_old',
        reference: hashOld,
        subscriptionExpires: expiredDate,
      }),
    )

    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_new', hashActivate),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          lookupKey: resolved.key,
          periodCount: request.periodCount,
          periodUnit: request.periodUnit,
          recipient: request.recipient,
          reference: hashActivate,
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_new',
        }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })

    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error('expected challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge)

    const activated = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: {
          Authorization: Credential.serialize(credential),
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )
    expect(activated.status).toBe(200)
    if (activated.status !== 200) throw new Error('expected activation')

    const receipt = Receipt.fromResponse(activated.withReceipt(new Response('OK')))
    expect(receipt.subscriptionId).toBe('sub_new')

    const current = await subscriptions.getByKey(subscriptionKey)
    expect(current?.subscriptionId).toBe('sub_new')
  })

  test('rejects activation when the dynamic access key does not match the credential', async () => {
    const store = Store.memory()
    const activateCalls: unknown[] = []
    const method = subscription({
      accessKey: async () => ({
        accessKeyAddress: accessAccount.address,
        keyType: 'p256',
      }),
      activate: async (parameters) => {
        activateCalls.push(parameters)
        return {
          receipt: createReceipt('sub_unused'),
          subscription: createRecord({ subscriptionId: 'sub_unused' }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge)
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(activateCalls.length).toBe(0)
  })

  test('rejects activation settlements that do not match the challenged request', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_bad', hashActivate),
        subscription: createRecord({
          amount: String(BigInt(request.amount) + 1n),
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          lookupKey: resolved.key,
          periodCount: request.periodCount,
          periodUnit: request.periodUnit,
          recipient: request.recipient,
          reference: hashActivate,
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_bad',
        }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge)
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(await subscriptions.getByKey(subscriptionKey)).toBe(null)
  })

  test('rejects activation settlements with a mismatched chainId', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_bad', hashActivate),
        subscription: createRecord({
          amount: request.amount,
          chainId: chainId + 1,
          currency: request.currency,
          lookupKey: resolved.key,
          periodCount: request.periodCount,
          periodUnit: request.periodUnit,
          recipient: request.recipient,
          reference: hashActivate,
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_bad',
        }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge)
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(await subscriptions.getByKey(subscriptionKey)).toBe(null)
  })

  test('rejects activation settlements with a mismatched externalId', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_bad', hashActivate),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          externalId: 'external_2',
          lookupKey: resolved.key,
          periodCount: request.periodCount,
          periodUnit: request.periodUnit,
          recipient: request.recipient,
          reference: hashActivate,
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_bad',
        }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      externalId: 'external_1',
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge)
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(await subscriptions.getByKey(subscriptionKey)).toBe(null)
  })

  test('rejects credentials when the current request externalId differs from the challenge', async () => {
    const store = Store.memory()
    let activationCount = 0
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async ({ request, resolved }) => {
        activationCount += 1
        return {
          receipt: createReceipt('sub_unused'),
          subscription: createRecord({
            amount: request.amount,
            chainId: request.methodDetails?.chainId,
            currency: request.currency,
            externalId: request.externalId,
            lookupKey: resolved.key,
            periodCount: request.periodCount,
            periodUnit: request.periodUnit,
            recipient: request.recipient,
            subscriptionExpires: request.subscriptionExpires,
            subscriptionId: 'sub_unused',
          }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({ externalId: 'external_1' })(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const credential = await createCredential(Challenge.fromResponse(challengeResult.challenge))
    const rejected = await mppx.tempo.subscription({ externalId: 'external_2' })(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(activationCount).toBe(0)
  })

  test('rejects credentials whose declared source does not match the key authorization signer', async () => {
    const store = Store.memory()
    const activateCalls: unknown[] = []
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async (parameters) => {
        activateCalls.push(parameters)
        return {
          receipt: createReceipt('sub_unused'),
          subscription: createRecord({ subscriptionId: 'sub_unused' }),
        }
      },
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = await createCredential(challenge, otherAccessAccount.address)
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )

    expect(rejected.status).toBe(402)
    expect(activateCalls.length).toBe(0)
  })

  test('renews an overdue matching subscription before falling back to 402', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const renewCalls: number[] = []
    const renewalReferences: string[] = []
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      renew: async ({ inFlightReference, periodIndex, subscription }) => {
        renewCalls.push(periodIndex)
        renewalReferences.push(inFlightReference)
        expect(subscription.inFlightReference).toBe(inFlightReference)
        return {
          receipt: createReceipt(subscription.subscriptionId, hashRenewed),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: hashRenewed,
          },
        }
      },
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    await subscriptions.put(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * subscriptionPeriodMilliseconds).toISOString(),
        lastChargedPeriod: 0,
        lookupKey: subscriptionKey,
        reference: hashStale,
        subscriptionId: 'sub_due',
      }),
    )

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const result = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { 'X-Subscription-Key': subscriptionKey },
      }),
    )

    expect(result.status).toBe(200)
    expect(renewCalls.length).toBe(1)
    expect(renewCalls[0]).toBeGreaterThan(0)
    expect(renewalReferences[0]).toBe(`renewal:sub_due:${renewCalls[0]}`)
    if (result.status !== 200) throw new Error('expected renewal success')

    const receipt = Receipt.fromResponse(result.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe(hashRenewed)
    expect(receipt.subscriptionId).toBe('sub_due')
    expect((await subscriptions.get('sub_due'))?.inFlightReference).toBe(undefined)
  })

  test('rejects renewals that change the active subscriptionId', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const method = subscription({
      accessKey: async () => accessKey,
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      renew: async ({ periodIndex, subscription }) => {
        const record = {
          ...subscription,
          lastChargedPeriod: periodIndex,
          reference: hashRenewed,
          subscriptionId: 'sub_other',
        }
        return {
          receipt: createReceipt(record.subscriptionId, hashRenewed),
          subscription: record,
        }
      },
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    await subscriptions.put(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * subscriptionPeriodMilliseconds).toISOString(),
        lastChargedPeriod: 0,
        lookupKey: subscriptionKey,
        reference: hashStale,
        subscriptionId: 'sub_due',
      }),
    )

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const rejected = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { 'X-Subscription-Key': subscriptionKey },
      }),
    )

    expect(rejected.status).toBe(402)
    expect((await subscriptions.getByKey(subscriptionKey))?.subscriptionId).toBe('sub_due')
    expect((await subscriptions.get('sub_due'))?.lastChargedPeriod).toBe(0)
  })

  test('charges an overdue subscription outside the request path', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const renewCalls: number[] = []

    await subscriptions.put(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * subscriptionPeriodMilliseconds).toISOString(),
        lastChargedPeriod: 0,
        lookupKey: subscriptionKey,
        reference: hashStale,
        subscriptionId: 'sub_background',
      }),
    )

    const result = await renew({
      renew: async ({ periodIndex, subscription }) => {
        renewCalls.push(periodIndex)
        return {
          receipt: createReceipt(subscription.subscriptionId, hashBackground),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: hashBackground,
          },
        }
      },
      store,
      subscriptionId: 'sub_background',
    })

    expect(result?.receipt.reference).toBe(hashBackground)
    expect(renewCalls.length).toBe(1)
    expect((await subscriptions.get('sub_background'))?.reference).toBe(hashBackground)
  })

  test('automatically renews an overdue subscription outside the request path', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const { client, rpcMethods } = createBillingClient([hashActivate, hashBackground])
    const method = subscription({
      amount: subscriptionAmount,
      chainId,
      currency: subscriptionCurrency,
      getClient: async () => client,
      periodCount: subscriptionPeriodCount,
      periodUnit: subscriptionPeriodUnit,
      recipient: subscriptionRecipient,
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
      waitForConfirmation: false,
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource'),
    )
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')
    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const accessKey = (
      challenge.request as ReturnType<typeof Methods.subscription.schema.request.parse>
    ).methodDetails?.accessKey
    if (!accessKey) throw new Error('expected generated access key')
    const credential = await createCredential(challenge, rootAccount.address, accessKey)
    const activated = await mppx.tempo.subscription({})(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(activated.status).toBe(200)

    const record = await subscriptions.getByKey(subscriptionKey)
    if (!record) throw new Error('expected subscription record')
    await subscriptions.put({
      ...record,
      billingAnchor: new Date(Date.now() - 3 * subscriptionPeriodMilliseconds).toISOString(),
      lastChargedPeriod: 0,
      reference: hashStale,
    })

    const result = await renew({
      getClient: async () => client,
      store,
      subscriptionId: record.subscriptionId,
      waitForConfirmation: false,
    })

    expect(result?.receipt.reference).toBe(hashBackground)
    expect(rpcMethods.filter((method) => method === 'eth_sendRawTransaction')).toHaveLength(2)
    expect((await subscriptions.get(record.subscriptionId))?.reference).toBe(hashBackground)
  })
})
