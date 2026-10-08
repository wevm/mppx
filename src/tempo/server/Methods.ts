import type { NoExtraKeys } from '../../internal/types.js'
import * as Store from '../../Store.js'
import * as Currencies from '../internal/currencies.js'
import * as ChannelStore from '../session/server/ChannelStore.js'
import {
  charge as sessionCharge_,
  session as session_,
  settle as settle_,
  settleBatch as settleBatch_,
} from '../session/server/Session.js'
import type { SessionController as SessionController_ } from '../session/server/Sse.js'
import * as Ws_ from '../session/server/Ws.js'
import { charge as charge_ } from './Charge.js'
import type * as Relay_ from './Relay.js'
import { renew as renewSubscription_, subscription as subscription_ } from './Subscription.js'

const sessionServer = Object.assign(session_, {
  charge: sessionCharge_,
  settle: settle_,
  settleBatch: settleBatch_,
})

function createChargeMethod<const parameters extends SharedParameters>(
  parameters: parameters | undefined,
) {
  // `tempo()` accepts the intersection of charge/session parameters, then
  // forwards only the fields each method understands. Preserve the inferred
  // parameter type so configured request defaults remain visible to handlers.
  return charge_(parameters as NoExtraKeys<parameters, charge_.Parameters> | undefined)
}

function createSessionMethod<const parameters extends SharedParameters>(
  parameters: parameters | undefined,
) {
  // These options apply only to charge, even when configured at the family level.
  const {
    allowedFeeTokens: _allowedFeeTokens,
    machineTokenEnabled: _machineTokenEnabled,
    ...sessionParameters
  } = parameters ?? {}
  return sessionServer(
    sessionParameters as NoExtraKeys<parameters, session_.Parameters> | undefined,
  )
}

/**
 * Creates the common Tempo `charge` and `session` methods from shared parameters.
 *
 * Mainnet accepts OUSD first, then USDC.e. Testnet accepts OUSD first, then pathUSD.
 * Use `currencies`
 * for an ordered list of addresses/token definitions, including a one-element
 * list for a single asset. Each currency creates charge and session offers; list
 * order is presentation order, not a requirement on the client's choice.
 * Chain-indexed definitions (including `tokens.tempo` from `viem/tokens`) are
 * filtered to USD tokens deployed on `chainId`. Duplicates are removed by address.
 * Explicit lists replace the defaults; an empty resolved list throws.
 *
 * The chain defaults to Tempo mainnet (Moderato with `testnet: true`). Set
 * `chainId` explicitly when using a custom client for another network.
 *
 * When configured, `relay` applies to the `charge` method. Session vouchers
 * remain local state transitions and session relay delegation will be added
 * with its action-specific lifecycle support.
 *
 * @example
 * ```ts
 * import { Mppx, tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo.common({ recipient: '0x...' })],
 * })
 * ```
 */
export function tempo<const parameters extends tempo.Parameters>(
  parameters?: NoExtraKeys<parameters, tempo.Parameters>,
) {
  if (parameters?.currency !== undefined) {
    if (parameters.currencies !== undefined)
      throw new Error('Specify either `currency` or `currencies`, not both.')
    return [createChargeMethod(parameters), createSessionMethod(parameters)] as const
  }
  const { currencies: _currencies, ...shared } = parameters ?? {}
  const [first, ...rest] = Currencies.resolve(parameters ?? {})
  const sessions = sessionOffers(
    parameters as NoExtraKeys<parameters, CurrencyParameters<session_.Parameters>> | undefined,
  )
  function createMethods(currency: typeof first, index: number) {
    const configured = { ...shared, ...currency } as unknown as Omit<
      parameters,
      'currency' | 'currencies' | 'decimals' | 'chainId'
    > &
      typeof currency
    return [createChargeMethod(configured), sessions[index]!] as const
  }
  return [
    ...createMethods(first, 0),
    ...rest.flatMap((currency, index) => createMethods(currency, index + 1)),
  ] as const
}

type SharedParameters = Omit<charge_.Parameters, 'machineTokenEnabled'> &
  session_.Parameters & {
    /** Enables MACH funding for compatible Tempo methods. Currently applies to `charge`. */
    machineTokenEnabled?: boolean | undefined
  }

export namespace tempo {
  /** An accepted address or chain-indexed USD token definition from `viem/tokens`. */
  export type Currency = Currencies.Currency
  /** Shared charge/session configuration with mutually exclusive currency options. */
  export type Parameters = Omit<SharedParameters, 'currency'> &
    (
      | {
          /** @deprecated Use `currencies: [currency]` instead. */
          currency?: string | undefined
          currencies?: undefined
        }
      | {
          currency?: undefined
          /** Ordered accepted currencies. Replaces defaults; filters token definitions by chain and USD denomination. */
          currencies: readonly Currency[]
        }
    )
  /** Tempo API relay configuration for server-side charges. */
  export type RelayOptions = charge_.RelayOptions
  /** Stable failure codes returned by Tempo API's MPP relay. */
  export type RelayErrorCode = Relay_.configure.ErrorCode
  /** Safe relay failure details exposed by the Tempo API relay. */
  export type RelayErrorDetails = Relay_.configure.ErrorDetails

  /** Creates ordered Tempo charge offers: OUSD first, then the network fallback. */
  export const charge = chargeOffers
  /** Creates the common Tempo `charge` and `session` methods from shared parameters. */
  export const common = tempo
  /** Creates ordered TIP-1034 session offers with shared storage and settlement helpers. */
  export const session = Object.assign(sessionOffers, {
    charge: sessionCharge_,
    settle: settle_,
    settleBatch: settleBatch_,
  })
  /** Creates ordered subscription offers. Existing subscriptions retain their authorized currency. */
  export const subscription = subscriptionOffers
  /** Renews an overdue Tempo subscription outside of the HTTP request path. */
  export const renewSubscription = renewSubscription_
  /** One-shot settle: reads highest voucher from storage and submits on-chain. */
  export const settle = settle_
  /** Batch-settle precompile-backed session channels. */
  export const settleBatch = settleBatch_
  /** Types for Tempo session streams. */
  export namespace Sse {
    /** Controller passed to manual-charge SSE generators. */
    export type SessionController = SessionController_
  }
  /** Experimental websocket helpers for Tempo sessions. */
  export const Ws = Ws_
}

/** Currency selection shared by the public Tempo intent factories. */
type CurrencyParameters<parameters> = Omit<parameters, 'currency'> &
  (
    | {
        /** @deprecated Use `currencies: [currency]` instead. */
        currency?: string | undefined
        currencies?: undefined
      }
    | { currency?: undefined; currencies: readonly Currencies.Currency[] }
  )

/** Resolves the public factory configuration while preserving explicit legacy currencies. */
function resolveCurrencies(parameters: {
  currency?: string | undefined
  currencies?: readonly Currencies.Currency[] | undefined
  chainId?: number | undefined
  testnet?: boolean | undefined
  decimals?: number | undefined
}) {
  if (parameters.currency !== undefined && parameters.currencies !== undefined)
    throw new Error('Specify either `currency` or `currencies`, not both.')
  return Currencies.resolve({
    ...parameters,
    ...(parameters.currency === undefined ? {} : { currencies: [parameters.currency] }),
  })
}

/** Creates OUSD-first charge offers, with explicit currency lists replacing the defaults. */
function chargeOffers<const parameters extends CurrencyParameters<charge_.Parameters>>(
  parameters?: NoExtraKeys<parameters, CurrencyParameters<charge_.Parameters>>,
) {
  const { currencies: _currencies, ...shared } = parameters ?? {}
  const [first, ...rest] = resolveCurrencies(parameters ?? {})
  function create(currency: typeof first) {
    const configured = { ...shared, ...currency } as unknown as Omit<
      parameters,
      'currencies' | 'currency' | 'decimals' | 'chainId'
    > &
      typeof currency
    return charge_(configured as NoExtraKeys<typeof configured, charge_.Parameters>)
  }
  return [create(first), ...rest.map(create)] as const
}

/** Creates OUSD-first session offers with shared storage and currency-aware settlement helpers. */
function sessionOffers<const parameters extends CurrencyParameters<session_.Parameters>>(
  parameters?: NoExtraKeys<parameters, CurrencyParameters<session_.Parameters>>,
) {
  const { currencies: _currencies, ...shared } = parameters ?? {}
  const [first, ...rest] = resolveCurrencies(parameters ?? {})
  const store = parameters?.store ?? Store.memory()
  const settlements = new Map<string, session_.Extensions['settleScheduled']>()
  const key = (chainId: number, currency: string) => `${chainId}:${currency.toLowerCase()}`
  const settleScheduled: session_.Extensions['settleScheduled'] = (channel) => {
    const settle = settlements.get(key(channel.chainId, channel.token))
    if (!settle) throw new Error('Channel currency is not configured for this session handler.')
    return settle(channel)
  }
  const extensions: session_.Extensions = {
    settleScheduled,
    serveWebSocket: (options) =>
      Ws_.serve({
        ...options,
        store: ChannelStore.fromStore(store),
        // Failed settlements are reported by the session handler; the charged request stays served.
        onChargeCommitted: (channel) => settleScheduled(channel).catch(() => undefined),
      }),
  }
  function create(currency: typeof first) {
    const configured = { ...shared, ...currency, store } as unknown as Omit<
      parameters,
      'currencies' | 'currency' | 'decimals' | 'chainId'
    > &
      typeof currency & { store: typeof store }
    const method = session_(configured as NoExtraKeys<typeof configured, session_.Parameters>)
    settlements.set(key(currency.chainId, currency.currency), method.extensions!.settleScheduled)
    return { ...method, extensions }
  }
  return [create(first), ...rest.map(create)] as const
}

/** Offers currencies for new subscriptions; stored subscriptions retain their authorized currency. */
function subscriptionOffers<const parameters extends CurrencyParameters<subscription_.Parameters>>(
  parameters: NoExtraKeys<parameters, CurrencyParameters<subscription_.Parameters>>,
) {
  const { currencies: _currencies, ...shared } = parameters
  const [first, ...rest] = resolveCurrencies(parameters)
  const store = parameters.store ?? Store.memory()
  function create(currency: typeof first) {
    const configured = { ...shared, ...currency, store } as unknown as Omit<
      parameters,
      'currencies' | 'currency' | 'decimals' | 'chainId'
    > &
      typeof currency & { store: typeof store }
    return subscription_(
      configured as NoExtraKeys<
        typeof configured & subscription_.Parameters,
        subscription_.Parameters
      >,
    )
  }
  return [create(first), ...rest.map(create)] as const
}
