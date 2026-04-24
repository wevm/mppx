import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { formatUnits, type Address } from 'viem'
import { Actions } from 'viem/tempo'

import * as Errors from '../../Errors.js'
import type { LooseOmit, MaybePromise, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type * as Html from '../../server/internal/html/config.ts'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import type * as z from '../../zod.js'
import * as Account from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import * as Proof from '../internal/proof.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import * as SubscriptionReceipt from '../subscription/Receipt.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type {
  SubscriptionAccessKey,
  SubscriptionCredentialPayload,
  SubscriptionIdentity,
  SubscriptionRecord,
  SubscriptionReceipt as SubscriptionReceiptValue,
  SubscriptionResolution,
  SubscriptionResource,
} from '../subscription/Types.js'
import { html as htmlContent } from './internal/html.gen.js'

/**
 * Creates a Tempo subscription method backed by a single active subscription per identity/resource.
 */
export function subscription<const parameters extends subscription.Parameters>(
  p: NoExtraKeys<parameters, subscription.Parameters>,
) {
  const parameters = p as parameters
  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
    html,
    periodSeconds,
    store: rawStore = Store.memory(),
    subscriptionExpires,
  } = parameters

  const store = SubscriptionStore.fromStore(rawStore)
  const getClient = Client.getResolver({
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const { recipient } = Account.resolve(parameters)

  type Defaults = subscription.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.subscription, Defaults>(Methods.subscription, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      periodSeconds,
      recipient,
      subscriptionExpires,
    } as unknown as Defaults,

    html: html
      ? {
          config: {
            accessKey: html.accessKey,
          },
          content: htmlContent,
          formatAmount: async (request: z.output<typeof Methods.subscription.schema.request>) => {
            const amount = await formatHtmlAmount({ getClient, request })
            return `${amount} / ${formatBillingInterval(request.periodSeconds)}`
          },
          text: html.text,
          theme: html.theme,
        }
      : undefined,

    async authorize({ input, request }) {
      const resolution = await parameters.resolve({ input, request })
      if (!resolution) return undefined

      return authorizeActiveSubscription({
        capture: parameters.capture,
        resolution,
        store,
      })
    },

    async request({ request }) {
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.chainId) return parameters.chainId
        if (parameters.testnet) return defaults.chainId.testnet
        return (await getClient({})).chain?.id ?? defaults.chainId.mainnet
      })()

      return {
        ...request,
        chainId,
      }
    },

    stableBinding(request) {
      return subscriptionBinding(request)
    },

    async verify({ credential, envelope, request }) {
      const parsedRequest = Methods.subscription.schema.request.parse(request)
      const source = credential.source ? Proof.parseProofSource(credential.source) : null
      const authorization = parseAndVerifyAuthorization({
        payload: credential.payload as SubscriptionCredentialPayload,
        request: parsedRequest,
        source,
      })

      const input = envelope
        ? new Request(envelope.capturedRequest.url, {
            headers: envelope.capturedRequest.headers,
            method: envelope.capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const resolution = await parameters.resolve({ input, request: parsedRequest })
      if (!resolution) {
        throw new Errors.VerificationFailedError({
          reason: 'subscription target could not be resolved for activation',
        })
      }

      const activation = await parameters.activate({
        authorization,
        credential: credential as typeof credential & {
          payload: SubscriptionCredentialPayload
        },
        input,
        request: parsedRequest,
        resolution,
        source,
      })

      await store.activate(normalizeSubscriptionRecord(activation.subscription, resolution))
      return activation.receipt
    },
  })
}

async function authorizeActiveSubscription(parameters: {
  capture: subscription.Parameters['capture']
  resolution: SubscriptionResolution
  store: SubscriptionStore.SubscriptionStore
}): Promise<Method.AuthorizeResult | Method.PendingResult | undefined> {
  const { capture, resolution, store } = parameters
  const subscription = await store.getActive(resolution.identity.id, resolution.resource.id)
  if (!subscription || !isActive(subscription)) return undefined

  const periodIndex = getPeriodIndex(subscription)
  if (periodIndex <= subscription.lastChargedPeriod) {
    return {
      receipt: SubscriptionReceipt.fromRecord(subscription),
    }
  }
  if (!capture) return undefined

  return (
    (await captureDueSubscription({
      capture,
      reason: 'request',
      store,
      subscription,
    })) ?? undefined
  )
}

async function captureDueSubscription(parameters: {
  capture: NonNullable<subscription.Parameters['capture']>
  reason: subscription.CaptureReason
  store: SubscriptionStore.SubscriptionStore
  subscription: SubscriptionRecord
}): Promise<subscription.RenewalResult | Method.PendingResult | null> {
  const { capture, reason, store, subscription } = parameters
  const periodIndex = getPeriodIndex(subscription)
  if (periodIndex <= subscription.lastChargedPeriod) return null

  const claimed = await store.claimPendingCapture(
    subscription.subscriptionId,
    periodIndex,
    Date.now(),
  )
  if (!claimed) return null

  try {
    const result = await capture({
      periodIndex,
      reason,
      subscription: claimed,
    })
    if (isPendingResult(result)) return result

    await store.completePendingCapture(result.subscription, periodIndex)
    return result
  } catch (error) {
    await store.clearPendingCapture(subscription.subscriptionId, periodIndex)
    throw error
  }
}

function parseAndVerifyAuthorization(parameters: {
  payload: SubscriptionCredentialPayload
  request: ReturnType<typeof Methods.subscription.schema.request.parse>
  source: { address: Address; chainId: number } | null
}): KeyAuthorization.KeyAuthorization<true> {
  const { payload, request, source } = parameters

  let authorization: KeyAuthorization.KeyAuthorization
  try {
    authorization = KeyAuthorization.deserialize(payload.signature)
  } catch {
    throw new Errors.InvalidPayloadError({ reason: 'subscription key authorization is malformed' })
  }

  if (!source) {
    throw new Errors.VerificationFailedError({
      reason: 'subscription credentials must include a proof source',
    })
  }

  const expectedChainId = request.methodDetails?.chainId
  if (expectedChainId === undefined) {
    throw new Errors.VerificationFailedError({
      reason: 'subscription request is missing chainId',
    })
  }
  if (authorization.chainId !== BigInt(expectedChainId)) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization chainId does not match request',
    })
  }
  if (source.chainId !== expectedChainId) {
    throw new Errors.VerificationFailedError({
      reason: 'proof source chainId does not match request',
    })
  }

  const expectedExpiry = Math.floor(new Date(request.subscriptionExpires).getTime() / 1_000)
  if ((authorization.expiry ?? 0) !== expectedExpiry) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization expiry does not match subscriptionExpires',
    })
  }

  if (!authorization.limits || authorization.limits.length !== 1) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization must contain exactly one token spending limit',
    })
  }

  const limit = authorization.limits[0]
  if (!limit) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization must contain exactly one token spending limit',
    })
  }
  if (String(limit.token).toLowerCase() !== request.currency.toLowerCase()) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization token does not match request',
    })
  }
  if (limit.limit.toString() !== request.amount) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization amount does not match request',
    })
  }

  if (!authorization.signature) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization signature is missing',
    })
  }

  const valid = SignatureEnvelope.verify(authorization.signature, {
    address: source.address,
    payload: KeyAuthorization.getSignPayload(authorization),
  })
  if (!valid) {
    throw new Errors.VerificationFailedError({
      reason: 'authorization signature does not match proof source',
    })
  }

  return authorization as KeyAuthorization.KeyAuthorization<true>
}

function normalizeSubscriptionRecord(
  record: SubscriptionRecord,
  resolution: SubscriptionResolution,
): SubscriptionRecord {
  return {
    ...record,
    identityId: resolution.identity.id,
    pendingPeriod: undefined,
    pendingPeriodStartedAt: undefined,
    resourceId: resolution.resource.id,
  }
}

function getPeriodIndex(subscription: SubscriptionRecord, now = Date.now()): number {
  const anchor = new Date(subscription.billingAnchor).getTime()
  const expires = new Date(subscription.subscriptionExpires).getTime()
  if (!Number.isFinite(anchor) || !Number.isFinite(expires) || now >= expires) {
    return Number.POSITIVE_INFINITY
  }

  const periodSeconds = Number(subscription.periodSeconds)
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, Math.floor((now - anchor) / (periodSeconds * 1_000)))
}

function isActive(subscription: SubscriptionRecord, now = Date.now()): boolean {
  if (subscription.revokedAt) return false

  const cancelEffectiveAt = subscription.cancelEffectiveAt
    ? new Date(subscription.cancelEffectiveAt).getTime()
    : Number.POSITIVE_INFINITY
  if (Number.isFinite(cancelEffectiveAt) && now >= cancelEffectiveAt) return false

  return new Date(subscription.subscriptionExpires).getTime() > now
}

function isPendingResult(value: unknown): value is Method.PendingResult {
  return !!value && typeof value === 'object' && 'response' in value && !('receipt' in value)
}

function subscriptionBinding(
  request: ReturnType<typeof Methods.subscription.schema.request.parse>,
) {
  return {
    amount: request.amount,
    chainId: request.methodDetails?.chainId,
    currency: request.currency,
    periodSeconds: request.periodSeconds,
    recipient: request.recipient,
    subscriptionExpires: request.subscriptionExpires,
  }
}

async function formatHtmlAmount(parameters: {
  getClient: ReturnType<typeof Client.getResolver>
  request: z.output<typeof Methods.subscription.schema.request>
}) {
  const { getClient, request } = parameters

  try {
    const chainId = request.methodDetails?.chainId
    if (chainId === undefined) throw new Error('no chainId')

    const client = await getClient({ chainId })
    const metadata = await Actions.token.getMetadata(client, {
      token: request.currency as `0x${string}`,
    })
    const symbol =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: metadata.currency,
        currencyDisplay: 'narrowSymbol',
      })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? metadata.currency

    return `${symbol}${formatUnits(BigInt(request.amount), metadata.decimals)}`
  } catch {
    return `$${request.amount}`
  }
}

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3_600
const SECONDS_PER_DAY = 86_400
const SECONDS_PER_WEEK = 604_800
const SECONDS_PER_MONTH = 2_592_000
const SECONDS_PER_YEAR = 31_536_000

function formatBillingInterval(periodSeconds: string) {
  switch (Number(periodSeconds)) {
    case SECONDS_PER_MINUTE:
      return 'minute'
    case SECONDS_PER_HOUR:
      return 'hour'
    case SECONDS_PER_DAY:
      return 'day'
    case SECONDS_PER_WEEK:
      return 'week'
    case SECONDS_PER_MONTH:
      return 'month'
    case SECONDS_PER_YEAR:
      return 'year'
    default:
      return `every ${periodSeconds}s`
  }
}

/**
 * Captures the current billing period for the active subscription at an identity/resource pair.
 */
export async function captureActive(
  parameters: captureActive.Parameters,
): Promise<captureActive.Result | null> {
  const { capture, identity, resource, store: rawStore = Store.memory() } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  const subscription = await store.getActive(identity.id, resource.id)
  if (!subscription || !isActive(subscription)) return null

  const result = await captureDueSubscription({
    capture,
    reason: 'background',
    store,
    subscription,
  })
  if (!result || isPendingResult(result)) {
    if (isPendingResult(result)) {
      throw new Error('captureActive() does not support pending capture results.')
    }
    return null
  }

  return result
}

/**
 * Finalizes a previously pending capture and clears the in-flight claim.
 */
export async function completeCapture(parameters: completeCapture.Parameters): Promise<void> {
  const { periodIndex, store: rawStore = Store.memory(), subscription } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  await store.completePendingCapture(subscription, periodIndex)
}

/**
 * Clears a previously claimed pending capture without advancing billing state.
 */
export async function failCapture(parameters: failCapture.Parameters): Promise<void> {
  const { periodIndex, store: rawStore = Store.memory(), subscriptionId } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  await store.clearPendingCapture(subscriptionId, periodIndex)
}

/**
 * Cancels a subscription effective at the provided timestamp.
 */
export async function cancel(parameters: cancel.Parameters): Promise<SubscriptionRecord | null> {
  const { cancelEffectiveAt, store: rawStore = Store.memory(), subscriptionId } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  return store.markCanceled(subscriptionId, cancelEffectiveAt)
}

/**
 * Revokes a subscription immediately.
 */
export async function revoke(parameters: revoke.Parameters): Promise<SubscriptionRecord | null> {
  const { revokedAt, store: rawStore = Store.memory(), subscriptionId } = parameters
  const store = SubscriptionStore.fromStore(rawStore)
  return store.markRevoked(subscriptionId, revokedAt)
}

export declare namespace captureActive {
  type Parameters = {
    /** Billing callback used to capture the next due period. */
    capture: NonNullable<subscription.Parameters['capture']>
    /** Subscription identity to bill. */
    identity: SubscriptionIdentity
    /** Subscription resource to bill. */
    resource: SubscriptionResource
    /** Store containing subscription records. */
    store?: Store.AtomicStore<Record<string, unknown>> | undefined
  }

  type Result = subscription.RenewalResult
}

export declare namespace completeCapture {
  type Parameters = {
    /** Period index that was captured. */
    periodIndex: number
    /** Updated subscription record to persist. */
    subscription: SubscriptionRecord
    /** Store containing subscription records. */
    store?: Store.AtomicStore<Record<string, unknown>> | undefined
  }
}

export declare namespace failCapture {
  type Parameters = {
    /** Period index whose pending claim should be cleared. */
    periodIndex: number
    /** Store containing subscription records. */
    store?: Store.AtomicStore<Record<string, unknown>> | undefined
    /** Subscription whose pending claim should be cleared. */
    subscriptionId: string
  }
}

export declare namespace cancel {
  type Parameters = {
    /** Timestamp when the subscription stops authorizing renewals. */
    cancelEffectiveAt: string
    /** Store containing subscription records. */
    store?: Store.AtomicStore<Record<string, unknown>> | undefined
    /** Subscription to cancel. */
    subscriptionId: string
  }
}

export declare namespace revoke {
  type Parameters = {
    /** Timestamp when the subscription was revoked. */
    revokedAt: string
    /** Store containing subscription records. */
    store?: Store.AtomicStore<Record<string, unknown>> | undefined
    /** Subscription to revoke. */
    subscriptionId: string
  }
}

export declare namespace subscription {
  type ActivationResult = {
    receipt: SubscriptionReceiptValue
    response?: Response | undefined
    subscription: SubscriptionRecord
  }

  type RenewalResult = {
    receipt: SubscriptionReceiptValue
    response?: Response | undefined
    subscription: SubscriptionRecord
  }

  type CaptureReason = 'background' | 'request'

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.subscription>, 'recipient'>

  type Parameters = Account.resolve.Parameters &
    Client.getResolver.Parameters & {
      activate: (parameters: {
        authorization: KeyAuthorization.KeyAuthorization<true>
        credential: {
          payload: SubscriptionCredentialPayload
          source?: string | undefined
        }
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
        resolution: SubscriptionResolution
        source: { address: Address; chainId: number } | null
      }) => Promise<ActivationResult>
      capture?: (parameters: {
        periodIndex: number
        reason: CaptureReason
        subscription: SubscriptionRecord
      }) => Promise<RenewalResult | Method.PendingResult>
      html?:
        | {
            accessKey: SubscriptionAccessKey
            text?: Html.Text | undefined
            theme?: Html.Theme | undefined
          }
        | undefined
      periodSeconds?: string | undefined
      resolve: (parameters: {
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
      }) => MaybePromise<SubscriptionResolution | null>
      store?: Store.AtomicStore<Record<string, unknown>> | undefined
      testnet?: boolean | undefined
    } & Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
