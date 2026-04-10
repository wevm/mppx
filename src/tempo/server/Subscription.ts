import type { Address } from 'viem'

import { PaymentRequiredError } from '../../Errors.js'
import type { LooseOmit, MaybePromise, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
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
  SubscriptionResource,
} from '../subscription/Types.js'

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

    async authorize({ input, request }) {
      const identity = await parameters.getIdentity({ input, request })
      if (!identity) return undefined

      const resource = await parameters.getResource({ identity, input, request })
      const subscriptionIdHint = input.headers.get('Subscription-Id')?.trim() || undefined
      const matches = (await store.listByIdentityResource(identity.id, resource.id)).filter((record) =>
        matchesRequest(record, request),
      )
      const active = matches.filter((record) => isActive(record))

      const subscription = (() => {
        if (subscriptionIdHint)
          return active.find((record) => record.subscriptionId === subscriptionIdHint) ?? null
        if (active.length <= 1) return active[0] ?? null
        throw new PaymentRequiredError({
          description:
            'Multiple active subscriptions match this request. Retry with the Subscription-Id header.',
        })
      })()

      if (!subscription) return undefined

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

function matchesRequest(
  subscription: SubscriptionRecord,
  request: ReturnType<typeof Methods.subscription.schema.request.parse>,
): boolean {
  const binding = subscriptionBinding(request)
  return (
    String(subscription.amount) === String(binding.amount) &&
    String(subscription.currency).toLowerCase() === String(binding.currency).toLowerCase() &&
    String(subscription.recipient).toLowerCase() === String(binding.recipient).toLowerCase() &&
    String(subscription.periodSeconds) === String(binding.periodSeconds) &&
    String(subscription.subscriptionExpires) === String(binding.subscriptionExpires) &&
    String(subscription.chainId) === String(binding.chainId)
  )
}

function subscriptionBinding(request: ReturnType<typeof Methods.subscription.schema.request.parse>) {
  return {
    amount: request.amount,
    chainId: request.methodDetails?.chainId,
    currency: request.currency,
    periodSeconds: request.periodSeconds,
    recipient: request.recipient,
    subscriptionExpires: request.subscriptionExpires,
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
    } &
    Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}
