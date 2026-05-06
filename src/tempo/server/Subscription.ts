import { Base64 } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { encodeFunctionData, isAddressEqual, type Address, type Client as ViemClient } from 'viem'
import {
  call as viem_call,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
} from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Account as TempoAccount, Transaction } from 'viem/tempo'

import { VerificationFailedError } from '../../Errors.js'
import type { LooseOmit, MaybePromise, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import type * as Client from '../../viem/Client.js'
import * as ClientResolver from '../../viem/Client.js'
import * as Attribution from '../Attribution.js'
import * as Account from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import * as Proof from '../internal/proof.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import {
  assertSubscriptionTiming,
  toSubscriptionPeriodSeconds,
  verifySubscriptionKeyAuthorization,
} from '../subscription/KeyAuthorization.js'
import * as SubscriptionReceipt from '../subscription/Receipt.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type {
  SubscriptionAccessKey,
  SubscriptionCredentialPayload,
  SubscriptionLookup,
  SubscriptionPeriodUnit,
  SubscriptionRecord,
  SubscriptionReceipt as SubscriptionReceiptValue,
} from '../subscription/Types.js'

type SubscriptionRequest = ReturnType<typeof Methods.subscription.schema.request.parse>

/**
 * Creates a Tempo subscription method for recurring TIP-20 token payments.
 *
 * The method handles activation, request-path reuse, and optional lazy renewals.
 */
export function subscription<const parameters extends subscription.Parameters>(
  p: NoExtraKeys<parameters, subscription.Parameters>,
) {
  const parameters = p as parameters
  const rawStore = (parameters.store ?? Store.memory()) as Store.AtomicStore<
    Record<string, unknown>
  >
  if (typeof rawStore.update !== 'function') {
    throw new Error('tempo.subscription() requires an atomic store with `update`.')
  }
  const defaultChainId = parameters.chainId ?? defaults.chainId.testnet
  const {
    amount,
    currency = defaults.resolveCurrency({ chainId: defaultChainId }),
    decimals = defaults.decimals,
    description,
    externalId,
    periodCount,
    periodUnit,
    subscriptionExpires,
    waitForConfirmation = true,
  } = parameters

  const store = SubscriptionStore.fromStore(rawStore, {
    activationTimeoutMs: parameters.activationTimeoutMs,
  })
  const { recipient } = Account.resolve(parameters)
  const getClient = ClientResolver.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = subscription.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.subscription, Defaults>(Methods.subscription, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      periodCount,
      periodUnit,
      recipient,
      subscriptionExpires,
    } as unknown as Defaults,

    async authorize({ input, request }) {
      const resolved = await parameters.resolve({ input, request })
      if (!resolved) return undefined

      const subscription = await store.getByKey(resolved.key)
      if (!subscription || !isActive(subscription)) return undefined

      const periodIndex = getPeriodIndex(subscription)
      if (periodIndex > subscription.lastChargedPeriod) {
        const renew = resolveRenewalHandler({
          getClient,
          parameters,
          store,
          subscription,
          waitForConfirmation,
        })
        if (!renew) return undefined

        const renewal = await settleRenewal({
          expectedLookupKey: resolved.key,
          periodIndex,
          renew,
          request,
          store,
          subscription,
        })
        if (!renewal) return undefined
        if (renewal.status === 'charged') return { receipt: renewal.receipt }

        await parameters.hooks?.renewed?.({
          periodIndex,
          receipt: renewal.result.receipt,
          subscription: renewal.result.subscription,
        })
        return {
          receipt: renewal.result.receipt,
        }
      }

      return {
        receipt: SubscriptionReceipt.fromRecord(subscription),
      }
    },

    async request({ capturedRequest, credential, request }) {
      const credentialRequest = credential?.challenge.request as SubscriptionRequest | undefined
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.chainId) return parameters.chainId
        if (credentialRequest?.methodDetails?.chainId)
          return credentialRequest.methodDetails.chainId
        return defaults.chainId.testnet
      })()
      const parsedRequest = Methods.subscription.schema.request.parse({
        ...request,
        chainId,
      })
      const input = capturedRequest
        ? new Request(capturedRequest.url, {
            headers: capturedRequest.headers,
            method: capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const resolved = await parameters.resolve({ input, request: parsedRequest })
      const existing = resolved ? await store.getByKey(resolved.key) : null
      const accessKey =
        resolved && !credential
          ? await resolveChallengeAccessKey({
              existing,
              input,
              parameters,
              request: parsedRequest,
              resolved,
              store,
            })
          : (credentialRequest?.methodDetails?.accessKey ?? parsedRequest.methodDetails?.accessKey)
      if (!accessKey) {
        throw new VerificationFailedError({ reason: 'subscription accessKey is missing' })
      }

      // Challenges carry the server-generated key in methodDetails so the shared request shape stays spec-compatible.
      return {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          accessKey,
        },
        chainId,
      }
    },

    stableBinding(request) {
      return subscriptionBinding(request)
    },

    async verify({ credential, envelope, request }) {
      const input = envelope
        ? new Request(envelope.capturedRequest.url, {
            headers: envelope.capturedRequest.headers,
            method: envelope.capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const parsedRequest = Methods.subscription.schema.request.parse(request)
      assertSubscriptionTiming({
        challengeExpires: credential.challenge.expires,
        request: parsedRequest,
      })
      const resolved = await parameters.resolve({ input, request: parsedRequest })

      if (!resolved) {
        throw new VerificationFailedError({ reason: 'subscription could not be resolved' })
      }
      const challengeRequest = credential.challenge.request as SubscriptionRequest
      const accessKey =
        challengeRequest.methodDetails?.accessKey ??
        parsedRequest.methodDetails?.accessKey ??
        (await resolveAccessKey({ input, parameters, request: parsedRequest, resolved }))
      if (!accessKey) {
        throw new VerificationFailedError({ reason: 'subscription accessKey is missing' })
      }
      const verified = verifySubscriptionKeyAuthorization({
        accessKey,
        chainId: parsedRequest.methodDetails?.chainId ?? defaults.chainId.testnet,
        payload: credential.payload as SubscriptionCredentialPayload,
        request: parsedRequest,
      })
      const declaredSource = credential.source ? Proof.parsePkhSource(credential.source) : null
      if (
        declaredSource &&
        (declaredSource.chainId !== verified.source.chainId ||
          !isAddressEqual(declaredSource.address, verified.source.address))
      ) {
        throw new VerificationFailedError({ reason: 'credential source does not match signature' })
      }

      // Claim the challenge before activation so replayed credentials cannot reach the charge hook.
      const activationClaimed = await store.claimActivation(credential.challenge.id)
      if (!activationClaimed) {
        throw new VerificationFailedError({
          reason: 'subscription credential has already been used',
        })
      }

      const existing = await store.getByKey(resolved.key)
      if (existing && isActive(existing)) {
        return SubscriptionReceipt.fromRecord(existing)
      }

      // Distinct challenges can target the same subscription key; serialize activation by key
      // before the first-period charge hook so concurrent fresh credentials cannot double-charge.
      const activationStarted = await store.beginActivation(resolved.key, credential.challenge.id)
      if (activationStarted.status !== 'started') {
        throw new VerificationFailedError({
          reason: 'subscription activation is already in flight',
        })
      }

      const activation = withSubscriptionAccessKey(
        await activateSubscription({
          accessKey,
          auto: {
            challengeId: credential.challenge.id,
            getClient,
            keyAuthorization: (credential.payload as SubscriptionCredentialPayload).signature,
            realm: credential.challenge.realm,
            store,
            waitForConfirmation,
          },
          credential: credential as typeof credential & {
            payload: SubscriptionCredentialPayload
          },
          input,
          parameters,
          request: parsedRequest,
          resolved,
          source: verified.source,
        }),
        accessKey,
      )

      validateSubscriptionSettlement(activation, {
        expectedLookupKey: resolved.key,
        expectedPeriodIndex: 0,
        request: parsedRequest,
      })

      const activationCommitted = await store.commitActivation(
        activation.subscription,
        credential.challenge.id,
      )
      if (!activationCommitted) {
        throw new VerificationFailedError({
          reason: 'subscription activation claim mismatch',
        })
      }
      await parameters.hooks?.activated?.({
        receipt: activation.receipt,
        subscription: activation.subscription,
      })
      return activation.receipt
    },
  })
}

async function resolveAccessKey(parameters: {
  input: Request
  parameters: subscription.Parameters
  request: SubscriptionRequest
  resolved: subscription.ResolvedSubscription
}) {
  const { input, parameters: subscriptionParameters, request, resolved } = parameters
  return (
    resolved.accessKey ??
    (subscriptionParameters.accessKey
      ? await subscriptionParameters.accessKey({ input, request, resolved })
      : undefined)
  )
}

async function resolveChallengeAccessKey(parameters: {
  existing: SubscriptionRecord | null
  input: Request
  parameters: subscription.Parameters
  request: SubscriptionRequest
  resolved: subscription.ResolvedSubscription
  store: SubscriptionStore.SubscriptionStore
}) {
  const {
    existing,
    input,
    parameters: subscriptionParameters,
    request,
    resolved,
    store,
  } = parameters
  if (!subscriptionParameters.activate) {
    // In automatic mode, the SDK owns the server access key so apps can issue
    // challenges from only their resolved subscription lookup key.
    const accessKey = await store.getOrCreateAccessKey(resolved.key)
    return {
      accessKeyAddress: accessKey.accessKeyAddress,
      keyType: accessKey.keyType,
    } satisfies SubscriptionAccessKey
  }
  // Manual activation keeps the lower-level API: callers can provide the
  // access key for new challenges, while active subscriptions reuse the stored key.
  return (
    (await resolveAccessKey({ input, parameters: subscriptionParameters, request, resolved })) ??
    (existing && isActive(existing) ? existing.accessKey : undefined)
  )
}

async function activateSubscription(parameters: {
  accessKey: SubscriptionAccessKey
  auto: {
    challengeId: string
    getClient: (parameters: { chainId?: number | undefined }) => MaybePromise<ViemClient>
    keyAuthorization: `0x${string}`
    realm: string
    store: SubscriptionStore.SubscriptionStore
    waitForConfirmation: boolean
  }
  credential: {
    payload: SubscriptionCredentialPayload
    source?: string | undefined
  }
  input: Request
  parameters: subscription.Parameters
  request: SubscriptionRequest
  resolved: subscription.ResolvedSubscription
  source: { address: Address; chainId: number } | null
}) {
  const {
    accessKey,
    auto,
    credential,
    input,
    parameters: subscriptionParameters,
    request,
    resolved,
    source,
  } = parameters
  if (subscriptionParameters.activate) {
    // A custom activate hook owns settlement and record creation.
    return subscriptionParameters.activate({
      accessKey,
      credential,
      input,
      request,
      resolved,
      source,
    })
  }
  if (!source) {
    throw new VerificationFailedError({ reason: 'subscription payer is missing' })
  }

  // Automatic activation bills the first period and persists the recurring
  // billing authority needed for request-path and background renewals.
  const reference = await submitSubscriptionPayment({
    accessKey,
    getClient: auto.getClient,
    keyAuthorization: auto.keyAuthorization,
    lookupKey: resolved.key,
    request,
    settlementReference: auto.challengeId,
    source,
    store: auto.store,
    waitForConfirmation: auto.waitForConfirmation,
    memoServerId: auto.realm,
  })
  const timestamp = new Date().toISOString()
  const subscription = {
    accessKey,
    amount: request.amount,
    billingAnchor: timestamp,
    chainId: request.methodDetails?.chainId,
    currency: request.currency,
    externalId: request.externalId,
    keyAuthorization: auto.keyAuthorization,
    lastChargedPeriod: 0,
    lookupKey: resolved.key,
    payer: source,
    periodCount: request.periodCount,
    periodUnit: request.periodUnit,
    recipient: request.recipient,
    reference,
    subscriptionExpires: request.subscriptionExpires,
    subscriptionId: createSubscriptionId(),
    timestamp,
  } satisfies SubscriptionRecord

  return {
    receipt: SubscriptionReceipt.createSubscriptionReceipt(subscription),
    subscription,
  }
}

async function settleRenewal(parameters: {
  expectedLookupKey: string
  periodIndex: number
  renew: (parameters: {
    inFlightReference: string
    periodIndex: number
    subscription: SubscriptionRecord
  }) => Promise<subscription.RenewalResult>
  request?: SubscriptionRequest | undefined
  store: SubscriptionStore.SubscriptionStore
  subscription: SubscriptionRecord
}): Promise<
  | { status: 'charged'; receipt: SubscriptionReceiptValue }
  | { status: 'renewed'; result: subscription.RenewalResult }
  | null
> {
  const { expectedLookupKey, periodIndex, renew, request, store, subscription } = parameters
  const inFlightReference = renewalReference(subscription.subscriptionId, periodIndex)
  const started = await store.beginRenewal(
    subscription.subscriptionId,
    periodIndex,
    inFlightReference,
  )
  if (started.status === 'charged') {
    return { receipt: SubscriptionReceipt.fromRecord(started.subscription), status: 'charged' }
  }
  if (started.status !== 'started') return null

  const renewed = withSubscriptionAccessKey(
    await renew({
      inFlightReference,
      periodIndex,
      subscription: started.subscription,
    }).catch(async (error) => {
      await store.failRenewal(subscription.subscriptionId, periodIndex)
      throw error
    }),
    started.subscription.accessKey,
  )
  validateSubscriptionSettlement(renewed, {
    expectedLookupKey,
    expectedPeriodIndex: periodIndex,
    expectedSubscriptionId: subscription.subscriptionId,
    request,
  })
  const committed = await store.commitRenewal(
    subscription.subscriptionId,
    renewed.subscription,
    periodIndex,
  )
  if (!committed) {
    throw new VerificationFailedError({ reason: 'subscription renewal claim mismatch' })
  }
  return { result: renewed, status: 'renewed' }
}

function renewalReference(subscriptionId: string, periodIndex: number): string {
  // This stable identifier is persisted before the billing hook runs so apps can
  // use it as an idempotency/reconciliation key if a renewal crashes mid-flight.
  return `renewal:${subscriptionId}:${periodIndex}`
}

function withSubscriptionAccessKey<
  result extends subscription.ActivationResult | subscription.RenewalResult,
>(result: result, accessKey: SubscriptionAccessKey | undefined): result {
  if (!accessKey || result.subscription.accessKey) return result
  return {
    ...result,
    subscription: {
      ...result.subscription,
      accessKey,
    },
  }
}

function getPeriodIndex(subscription: SubscriptionRecord): number {
  const anchor = new Date(subscription.billingAnchor).getTime()
  const expires = new Date(subscription.subscriptionExpires).getTime()
  const now = Date.now()
  if (!Number.isFinite(anchor) || !Number.isFinite(expires) || now >= expires) {
    return Number.POSITIVE_INFINITY
  }

  let periodSeconds: number
  try {
    periodSeconds = toSubscriptionPeriodSeconds(subscription)
  } catch {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, Math.floor((now - anchor) / (periodSeconds * 1_000)))
}

function isActive(subscription: SubscriptionRecord): boolean {
  if (subscription.canceledAt || subscription.revokedAt) return false
  return new Date(subscription.subscriptionExpires).getTime() > Date.now()
}

function validateSubscriptionSettlement(
  result: subscription.ActivationResult | subscription.RenewalResult,
  options: {
    expectedLookupKey: string
    expectedPeriodIndex: number
    expectedSubscriptionId?: string | undefined
    request?: SubscriptionRequest | undefined
  },
) {
  const { receipt, subscription } = result
  assertSubscriptionReceipt(receipt, subscription)
  assertSubscriptionRecord(subscription, options)

  if (options.request) {
    assertSubscriptionRequestMatch(subscription, options.request)
  }
}

function assertSubscriptionReceipt(
  receipt: SubscriptionReceiptValue,
  subscription: SubscriptionRecord,
) {
  if (receipt.method !== 'tempo' || receipt.status !== 'success') {
    throw new VerificationFailedError({ reason: 'subscription receipt is invalid' })
  }
  if (receipt.subscriptionId !== subscription.subscriptionId) {
    throw new VerificationFailedError({ reason: 'subscription receipt id mismatch' })
  }
  if (receipt.reference !== subscription.reference) {
    throw new VerificationFailedError({ reason: 'subscription receipt reference mismatch' })
  }
  if (receipt.timestamp !== subscription.timestamp) {
    throw new VerificationFailedError({ reason: 'subscription receipt timestamp mismatch' })
  }
  assertTransactionHash(receipt.reference, 'subscription reference must be a transaction hash')
  assertValidDate(receipt.timestamp, 'subscription receipt timestamp is invalid')
}

function assertSubscriptionRecord(
  subscription: SubscriptionRecord,
  options: {
    expectedLookupKey: string
    expectedPeriodIndex: number
    expectedSubscriptionId?: string | undefined
  },
) {
  assertBase64Url(subscription.subscriptionId, 'subscriptionId must be base64url')
  assertTransactionHash(subscription.reference, 'subscription reference must be a transaction hash')
  const billingAnchor = assertValidDate(
    subscription.billingAnchor,
    'subscription billingAnchor is invalid',
  )
  const subscriptionExpires = assertValidDate(
    subscription.subscriptionExpires,
    'subscriptionExpires is invalid',
  )

  assertEqual(subscription.lookupKey, options.expectedLookupKey, {
    reason: 'subscription lookupKey does not match the resolved key',
  })
  assertEqual(subscription.lastChargedPeriod, options.expectedPeriodIndex, {
    reason: 'subscription lastChargedPeriod does not match the settled period',
  })
  if (options.expectedSubscriptionId) {
    assertEqual(subscription.subscriptionId, options.expectedSubscriptionId, {
      reason: 'subscriptionId does not match the active subscription',
    })
  }
  if (billingAnchor >= subscriptionExpires) {
    throw new VerificationFailedError({
      reason: 'subscription billingAnchor must be before subscriptionExpires',
    })
  }
}

function assertSubscriptionRequestMatch(
  subscription: SubscriptionRecord,
  request: SubscriptionRequest,
) {
  const matches =
    subscription.amount === request.amount &&
    subscription.chainId === request.methodDetails?.chainId &&
    subscription.currency.toLowerCase() === request.currency.toLowerCase() &&
    subscription.externalId === request.externalId &&
    subscription.periodCount === request.periodCount &&
    subscription.periodUnit === request.periodUnit &&
    subscription.recipient.toLowerCase() === request.recipient.toLowerCase() &&
    subscription.subscriptionExpires === request.subscriptionExpires

  if (!matches) {
    throw new VerificationFailedError({ reason: 'subscription record does not match request' })
  }
}

function assertBase64Url(value: string, reason: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new VerificationFailedError({ reason })
  }
}

function assertTransactionHash(value: string, reason: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new VerificationFailedError({ reason })
  }
}

function assertValidDate(value: string, reason: string) {
  const milliseconds = new Date(value).getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new VerificationFailedError({ reason })
  }
  return milliseconds
}

function assertEqual<value>(actual: value, expected: value, options: { reason: string }) {
  if (actual !== expected) {
    throw new VerificationFailedError(options)
  }
}

function subscriptionBinding(request: SubscriptionRequest) {
  return {
    amount: request.amount,
    chainId: request.methodDetails?.chainId,
    currency: request.currency,
    externalId: request.externalId,
    periodCount: request.periodCount,
    periodUnit: request.periodUnit,
    recipient: request.recipient,
    subscriptionExpires: request.subscriptionExpires,
  }
}

function resolveRenewalHandler(parameters: {
  getClient: (parameters: { chainId?: number | undefined }) => MaybePromise<ViemClient>
  parameters: {
    renew?:
      | ((parameters: {
          inFlightReference: string
          periodIndex: number
          subscription: SubscriptionRecord
        }) => Promise<subscription.RenewalResult>)
      | undefined
  }
  store: SubscriptionStore.SubscriptionStore
  subscription: SubscriptionRecord
  waitForConfirmation: boolean
}):
  | ((parameters: {
      inFlightReference: string
      periodIndex: number
      subscription: SubscriptionRecord
    }) => Promise<subscription.RenewalResult>)
  | undefined {
  const {
    getClient,
    parameters: subscriptionParameters,
    store,
    subscription,
    waitForConfirmation,
  } = parameters
  if (subscriptionParameters.renew) return subscriptionParameters.renew
  if (!subscription.accessKey || !subscription.keyAuthorization || !subscription.payer)
    return undefined
  return async ({ inFlightReference, periodIndex, subscription }) => {
    const reference = await submitSubscriptionPayment({
      accessKey: subscription.accessKey!,
      getClient,
      keyAuthorization: subscription.keyAuthorization!,
      lookupKey: subscription.lookupKey,
      memoServerId: subscription.lookupKey,
      request: subscription,
      settlementReference: inFlightReference,
      source: subscription.payer!,
      store,
      waitForConfirmation,
    })
    const record = {
      ...subscription,
      lastChargedPeriod: periodIndex,
      reference,
      timestamp: new Date().toISOString(),
    } satisfies SubscriptionRecord
    return {
      receipt: SubscriptionReceipt.createSubscriptionReceipt(record),
      subscription: record,
    }
  }
}

async function submitSubscriptionPayment(parameters: {
  accessKey: SubscriptionAccessKey
  getClient: (parameters: { chainId?: number | undefined }) => MaybePromise<ViemClient>
  keyAuthorization: `0x${string}`
  lookupKey: string
  memoServerId: string
  request: Pick<SubscriptionRequest, 'amount'> & {
    methodDetails?: { chainId?: number | undefined } | undefined
  } & { currency: Address | string; recipient: Address | string }
  settlementReference: string
  source: { address: Address; chainId: number }
  store: SubscriptionStore.SubscriptionStore
  waitForConfirmation: boolean
}) {
  const {
    accessKey,
    getClient,
    keyAuthorization,
    lookupKey,
    memoServerId,
    request,
    settlementReference,
    source,
    store,
    waitForConfirmation,
  } = parameters
  const stored = await store.getAccessKey(lookupKey)
  if (!stored) {
    throw new VerificationFailedError({ reason: 'subscription access key is missing' })
  }
  const rawAccessAccount = TempoAccount.fromSecp256k1(stored.privateKey)
  if (!isAddressEqual(rawAccessAccount.address, accessKey.accessKeyAddress)) {
    throw new VerificationFailedError({
      reason: 'subscription access key does not match stored key',
    })
  }

  const chainId = request.methodDetails?.chainId ?? source.chainId
  const client = await getClient({ chainId })
  const account = TempoAccount.fromSecp256k1(stored.privateKey, {
    access: source.address,
  })
  const memo = Attribution.encode({
    challengeId: settlementReference,
    serverId: memoServerId,
  })
  const serializedTransaction = await signTransaction(client, {
    account,
    calls: [
      {
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'transferWithMemo',
          args: [request.recipient as Address, BigInt(request.amount), memo],
        }),
        to: request.currency as Address,
      },
    ],
    chainId,
    keyAuthorization: KeyAuthorization.deserialize(keyAuthorization),
  } as never)
  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  await viem_call(client, {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls,
  } as never)

  if (!waitForConfirmation) {
    return sendRawTransaction(client, {
      serializedTransaction: serializedTransaction as Transaction.TransactionSerializedTempo,
    })
  }

  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serializedTransaction as Transaction.TransactionSerializedTempo,
  })
  if (receipt.status !== 'success') {
    throw new VerificationFailedError({
      reason: `subscription transaction reverted: ${receipt.transactionHash}`,
    })
  }
  return receipt.transactionHash
}

function createSubscriptionId() {
  const bytes = new Uint8Array(18)
  globalThis.crypto.getRandomValues(bytes)
  return Base64.fromBytes(bytes, { url: true }).replace(/=+$/, '')
}

/**
 * Renews an overdue subscription outside of the HTTP request path.
 * Intended for cron jobs or background workers that bill subscriptions on a schedule.
 *
 * Returns the renewal result if the subscription was overdue, or `null` if already current.
 */
export async function renew(parameters: renew.Parameters): Promise<renew.Result | null> {
  const { store: rawStore, waitForConfirmation = true } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  const getClient = ClientResolver.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  const record = await store.get(parameters.subscriptionId)
  if (!record) return null
  if (!isActive(record)) return null

  const periodIndex = getPeriodIndex(record)
  if (periodIndex <= record.lastChargedPeriod) return null

  const renew = resolveRenewalHandler({
    getClient,
    parameters,
    store,
    subscription: record,
    waitForConfirmation,
  })
  if (!renew) return null

  const renewal = await settleRenewal({
    expectedLookupKey: record.lookupKey,
    periodIndex,
    renew,
    store,
    subscription: record,
  })
  return renewal?.status === 'renewed' ? renewal.result : null
}

export declare namespace renew {
  /** Parameters for renewing an overdue subscription outside the request path. */
  type Parameters = {
    /** The subscription to renew. */
    subscriptionId: string
    /** Billing callback — same signature as the `renew` hook on {@link subscription}. */
    renew?:
      | ((parameters: {
          /** Stable idempotency/reconciliation reference persisted before the renewal hook runs. */
          inFlightReference: string
          periodIndex: number
          subscription: SubscriptionRecord
        }) => Promise<subscription.RenewalResult>)
      | undefined
    /** Store containing subscription records. */
    store: Store.AtomicStore<Record<string, unknown>>
    waitForConfirmation?: boolean | undefined
  } & Client.getResolver.Parameters

  /** Renewal result returned by {@link renew}. */
  type Result = subscription.RenewalResult
}

export declare namespace subscription {
  /** Request-scoped lookup key used to find the active subscription. */
  type ResolvedSubscription = SubscriptionLookup

  /** Activation result returned after the initial credential is verified. */
  type ActivationResult = {
    receipt: SubscriptionReceiptValue
    subscription: SubscriptionRecord
  }

  /** Renewal result returned when an overdue subscription is charged. */
  type RenewalResult = {
    receipt: SubscriptionReceiptValue
    subscription: SubscriptionRecord
  }

  /** Request defaults supported by the subscription method. */
  type Defaults = LooseOmit<
    Method.RequestDefaults<typeof Methods.subscription>,
    'accessKey' | 'recipient'
  >

  /** Parameters for configuring a Tempo subscription method. */
  type Parameters = Account.resolve.Parameters &
    Client.getResolver.Parameters & {
      accessKey?:
        | ((parameters: {
            input: Request
            request: SubscriptionRequest
            resolved: ResolvedSubscription
          }) => MaybePromise<SubscriptionAccessKey>)
        | undefined
      /**
       * Milliseconds before an in-flight activation lock can be replaced.
       * Keeps concurrent activation safe while allowing recovery from abandoned attempts.
       */
      activationTimeoutMs?: number | undefined
      activate?:
        | ((parameters: {
            accessKey: SubscriptionAccessKey
            credential: {
              payload: SubscriptionCredentialPayload
              source?: string | undefined
            }
            input: Request
            request: SubscriptionRequest
            resolved: ResolvedSubscription
            source: { address: Address; chainId: number } | null
          }) => Promise<ActivationResult>)
        | undefined
      hooks?:
        | {
            activated?:
              | ((parameters: {
                  receipt: SubscriptionReceiptValue
                  subscription: SubscriptionRecord
                }) => MaybePromise<void>)
              | undefined
            renewed?:
              | ((parameters: {
                  periodIndex: number
                  receipt: SubscriptionReceiptValue
                  subscription: SubscriptionRecord
                }) => MaybePromise<void>)
              | undefined
          }
        | undefined
      periodCount?: string | undefined
      periodUnit?: SubscriptionPeriodUnit | undefined
      resolve: (parameters: {
        input: Request
        request: SubscriptionRequest
      }) => MaybePromise<ResolvedSubscription | null>
      renew?: (parameters: {
        /** Stable idempotency/reconciliation reference persisted before the renewal hook runs. */
        inFlightReference: string
        periodIndex: number
        subscription: SubscriptionRecord
      }) => Promise<RenewalResult>
      store?: Store.AtomicStore<Record<string, unknown>> | undefined
      testnet?: boolean | undefined
      waitForConfirmation?: boolean | undefined
    } & Defaults

  /** Derived defaults after account and chain configuration are applied. */
  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
