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
  return tempo.charge(parameters as NoExtraKeys<parameters, charge_.Parameters> | undefined)
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
 * Mainnet accepts OUSD first, then USDC.e. Testnet accepts pathUSD. Use `currencies`
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
  const store = parameters?.store ?? Store.memory()
  const settlements = new Map<string, session_.Extensions['settleScheduled']>()
  const settlementKey = (chainId: number, currency: string) =>
    `${chainId}:${currency.toLowerCase()}`
  // Named session helpers share a store but retain each token's raw-unit schedule.
  const settleScheduled: session_.Extensions['settleScheduled'] = (channel) => {
    const settle = settlements.get(settlementKey(channel.chainId, channel.token))
    if (!settle) throw new Error('Channel currency is not configured for this session handler.')
    return settle(channel)
  }
  const extensions: session_.Extensions = {
    settleScheduled,
    serveWebSocket: (options) =>
      Ws_.serve({
        ...options,
        store: ChannelStore.fromStore(store),
        onChargeCommitted: settleScheduled,
      }),
  }
  function createMethods(currency: typeof first) {
    const configured = { ...shared, ...currency } as unknown as Omit<
      parameters,
      'currency' | 'currencies' | 'decimals' | 'chainId'
    > &
      typeof currency
    const session = createSessionMethod({ ...configured, store })
    settlements.set(
      settlementKey(currency.chainId, currency.currency),
      session.extensions!.settleScheduled,
    )
    const configuredSession: typeof session = { ...session, extensions }
    return [createChargeMethod(configured), configuredSession] as const
  }
  return [...createMethods(first), ...rest.flatMap(createMethods)] as const
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

  /** Creates a Tempo `charge` method for one-time TIP-20 token transfers. */
  export const charge = charge_
  /** Creates the common Tempo `charge` and `session` methods from shared parameters. */
  export const common = tempo
  /** Creates a TIP-1034 Tempo `session` method for session-based TIP-20 token payments. */
  export const session = sessionServer
  /** Creates a Tempo `subscription` method for recurring TIP-20 token payments. */
  export const subscription = subscription_
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
