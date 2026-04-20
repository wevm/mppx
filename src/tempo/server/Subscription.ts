import { formatUnits, type Address } from 'viem'
import { Actions } from 'viem/tempo'

import { VerificationFailedError } from '../../Errors.js'
import type { LooseOmit, MaybePromise, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type * as Html from '../../server/internal/html/config.js'
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
  SubscriptionLookup,
  SubscriptionRecord,
  SubscriptionReceipt as SubscriptionReceiptValue,
} from '../subscription/Types.js'
import { html as htmlContent } from './internal/html.gen.js'

/**
 * Creates a Tempo subscription method for recurring TIP-20 token payments.
 *
 * The method handles activation, request-path reuse, and optional lazy renewals.
 */
export function subscription<const parameters extends subscription.Parameters>(
  p: NoExtraKeys<parameters, subscription.Parameters>,
) {
  const parameters = p as parameters
  if (!parameters.store) {
    throw new Error(
      'tempo.subscription() requires a `store` so subscriptions can be reused and renewed.',
    )
  }

  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
    html,
    periodSeconds,
    store: rawStore,
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
      const resolved = await parameters.resolve({ input, request })
      if (!resolved) return undefined

      const subscription = await store.getByKey(resolved.key)
      if (!subscription || !isActive(subscription)) return undefined

      const periodIndex = getPeriodIndex(subscription)
      if (periodIndex > subscription.lastChargedPeriod) {
        if (!parameters.renew) return undefined

        const renewed = await parameters.renew({
          periodIndex,
          subscription,
        })
        await store.put(renewed.subscription)
        return {
          receipt: renewed.receipt,
        }
      }

      return {
        receipt: SubscriptionReceipt.fromRecord(subscription),
      }
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
      const source = credential.source ? Proof.parseProofSource(credential.source) : null
      const input = envelope
        ? new Request(envelope.capturedRequest.url, {
            headers: envelope.capturedRequest.headers,
            method: envelope.capturedRequest.method,
          })
        : new Request('https://subscription.invalid')
      const parsedRequest = Methods.subscription.schema.request.parse(request)
      const resolved = await parameters.resolve({ input, request: parsedRequest })

      if (!resolved) {
        throw new VerificationFailedError({ reason: 'subscription could not be resolved' })
      }

      const activation = await parameters.activate({
        credential: credential as typeof credential & {
          payload: SubscriptionCredentialPayload
        },
        input,
        request: parsedRequest,
        resolved,
        source,
      })

      if (activation.subscription.lookupKey !== resolved.key) {
        throw new VerificationFailedError({
          reason: 'subscription lookupKey does not match the resolved key',
        })
      }

      await store.put(activation.subscription)
      return activation.receipt
    },
  })
}

function getPeriodIndex(subscription: SubscriptionRecord): number {
  const anchor = new Date(subscription.billingAnchor).getTime()
  const expires = new Date(subscription.subscriptionExpires).getTime()
  const now = Date.now()
  if (!Number.isFinite(anchor) || !Number.isFinite(expires) || now >= expires) {
    return Number.POSITIVE_INFINITY
  }

  const periodSeconds = Number(subscription.periodSeconds)
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return Math.max(0, Math.floor((now - anchor) / (periodSeconds * 1_000)))
}

function isActive(subscription: SubscriptionRecord): boolean {
  if (subscription.canceledAt || subscription.revokedAt) return false
  return new Date(subscription.subscriptionExpires).getTime() > Date.now()
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
 * Charges an overdue subscription outside of the HTTP request path.
 * Intended for cron jobs or background workers that bill subscriptions on a schedule.
 *
 * Returns the renewal result if the subscription was overdue, or `null` if already current.
 */
export async function charge(parameters: charge.Parameters): Promise<charge.Result | null> {
  const { renew, store: rawStore } = parameters
  const store = SubscriptionStore.fromStore(rawStore)

  const record = await store.get(parameters.subscriptionId)
  if (!record) return null
  if (!isActive(record)) return null

  const periodIndex = getPeriodIndex(record)
  if (periodIndex <= record.lastChargedPeriod) return null

  const renewed = await renew({ periodIndex, subscription: record })
  await store.put(renewed.subscription)
  return renewed
}

export declare namespace charge {
  /** Parameters for charging an overdue subscription outside the request path. */
  type Parameters = {
    /** The subscription to charge. */
    subscriptionId: string
    /** Billing callback — same signature as the `renew` hook on {@link subscription}. */
    renew: (parameters: {
      periodIndex: number
      subscription: SubscriptionRecord
    }) => Promise<subscription.RenewalResult>
    /** Store containing subscription records. */
    store: Store.Store<Record<string, unknown>>
  }

  /** Renewal result returned by {@link charge}. */
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
  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.subscription>, 'recipient'>

  /** Parameters for configuring a Tempo subscription method. */
  type Parameters = Account.resolve.Parameters &
    Client.getResolver.Parameters & {
      activate: (parameters: {
        credential: {
          payload: SubscriptionCredentialPayload
          source?: string | undefined
        }
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
        resolved: ResolvedSubscription
        source: { address: Address; chainId: number } | null
      }) => Promise<ActivationResult>
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
      }) => MaybePromise<ResolvedSubscription | null>
      renew?: (parameters: {
        periodIndex: number
        subscription: SubscriptionRecord
      }) => Promise<RenewalResult>
      store: Store.Store<Record<string, unknown>>
      testnet?: boolean | undefined
    } & Defaults

  /** Derived defaults after account and chain configuration are applied. */
  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
