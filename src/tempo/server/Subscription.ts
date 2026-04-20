import { formatUnits, type Address } from 'viem'
import { Actions } from 'viem/tempo'

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
  SubscriptionCredentialPayload,
  SubscriptionIdentity,
  SubscriptionRecord,
  SubscriptionReceipt as SubscriptionReceiptValue,
  SubscriptionAccessKey,
  SubscriptionResource,
} from '../subscription/Types.js'
import { html as htmlContent } from './internal/html.gen.js'

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
            ...(html.allowMemo !== undefined ? { allowMemo: html.allowMemo } : {}),
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
      const identity = await parameters.getIdentity({ input, request })
      if (!identity) return undefined

      const resource = await parameters.getResource({ identity, input, request })
      const subscription = await store.getByIdentityResource(identity.id, resource.id)
      if (!subscription || !isActive(subscription)) return undefined

      const periodIndex = getPeriodIndex(subscription)
      if (periodIndex > subscription.lastChargedPeriod) {
        if (!parameters.renew) return undefined
        const renewed = await parameters.renew({
          identity,
          input,
          periodIndex,
          request,
          resource,
          subscription,
        })
        await store.put(renewed.subscription)
        return {
          receipt: renewed.receipt,
          response: renewed.response,
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
      const activation = await parameters.activate({
        credential: credential as typeof credential & {
          payload: SubscriptionCredentialPayload
        },
        input,
        request: Methods.subscription.schema.request.parse(request),
        source,
      })
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
  const { renew, store: rawStore = Store.memory() } = parameters
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
  type Parameters = {
    /** The subscription to charge. */
    subscriptionId: string
    /** Billing callback — same signature as the `renew` hook on {@link subscription}. */
    renew: (parameters: {
      periodIndex: number
      subscription: SubscriptionRecord
    }) => Promise<subscription.RenewalResult>
    /** Store containing subscription records. */
    store?: Store.Store<Record<string, unknown>> | undefined
  }

  type Result = subscription.RenewalResult
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

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.subscription>, 'recipient'>

  type Parameters = Account.resolve.Parameters &
    Client.getResolver.Parameters & {
      getIdentity: (parameters: {
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
      }) => MaybePromise<SubscriptionIdentity | null>
      getResource: (parameters: {
        identity: SubscriptionIdentity
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
      }) => MaybePromise<SubscriptionResource>
      activate: (parameters: {
        credential: {
          payload: SubscriptionCredentialPayload
          source?: string | undefined
        }
        input: Request
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
        source: { address: Address; chainId: number } | null
      }) => Promise<ActivationResult>
      html?:
        | {
            accessKey: SubscriptionAccessKey
            allowMemo?: boolean | undefined
            text?: Html.Text | undefined
            theme?: Html.Theme | undefined
          }
        | undefined
      periodSeconds?: string | undefined
      renew?: (parameters: {
        identity: SubscriptionIdentity
        input: Request
        periodIndex: number
        request: ReturnType<typeof Methods.subscription.schema.request.parse>
        resource: SubscriptionResource
        subscription: SubscriptionRecord
      }) => Promise<RenewalResult>
      store?: Store.Store<Record<string, unknown>> | undefined
      testnet?: boolean | undefined
    } & Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
