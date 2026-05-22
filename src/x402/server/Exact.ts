import { isDeepStrictEqual } from 'node:util'

import { VerificationFailedError } from '../../Errors.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as Assets from '../Assets.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'
import * as Transport from './Transport.js'

/**
 * Creates an x402 exact server method.
 *
 * The public config hides x402 wire `extra` fields. Known assets provide the
 * required EIP-712 domain metadata automatically; custom assets must provide a
 * typed `transfer` config.
 */
export function exact<const parameters extends exact.Parameters>(parameters: parameters) {
  const config = resolveConfig(parameters.config)
  const facilitator = resolveFacilitator(config.facilitator)
  const transport = Transport.http()

  return Method.toServer<typeof Methods.exact, exact.Defaults, typeof transport>(Methods.exact, {
    defaults: {
      asset: config.asset,
      decimals: config.decimals,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      network: config.network,
      payTo: config.payTo,
      transfer: config.transfer,
    },
    transport,
    async verify({ credential }) {
      const paymentPayload = credential.payload as Types.PaymentPayload
      const paymentRequirements = Types.toPaymentRequirements(
        credential.challenge.request as Types.ExactRequest,
      )

      if (!isDeepStrictEqual(paymentPayload.accepted, paymentRequirements))
        throw new VerificationFailedError({
          reason: 'x402 payment payload does not match route requirements',
        })

      const verified = await facilitator.verify(paymentPayload, paymentRequirements)
      if (!verified.isValid)
        throw new VerificationFailedError({
          reason: verified.invalidMessage ?? verified.invalidReason ?? 'x402 verify failed',
        })

      const settled = await facilitator.settle(paymentPayload, paymentRequirements)
      if (!settled.success)
        throw new VerificationFailedError({
          reason: settled.errorMessage ?? settled.errorReason ?? 'x402 settlement failed',
        })

      return Receipt.from({
        method: Types.paymentMethod,
        reference: settled.transaction,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}

export declare namespace exact {
  type Parameters = {
    config: Config
  }

  type Config = BaseConfig & CurrencyConfig & RecipientConfig

  type BaseConfig = {
    /** Token decimal places. Required for custom currency addresses; inferred for known assets. */
    decimals?: number | undefined
    /** Facilitator client or base URL. */
    facilitator: string | Types.Facilitator
    /** Maximum time in seconds allowed for payment completion. @default 60 */
    maxTimeoutSeconds?: number | undefined
    /** CAIP-2 network. Required for custom asset addresses; inferred for known assets. */
    network?: Types.EvmNetwork | undefined
    /** Required for custom asset addresses; inferred for known assets. */
    transfer?: Types.ExactTransfer | undefined
  }

  type CurrencyConfig =
    | {
        /** Token contract address or known x402 asset metadata. */
        currency: `0x${string}` | Assets.KnownAsset
        /** Legacy alias for `currency`. */
        asset?: `0x${string}` | Assets.KnownAsset | undefined
      }
    | {
        /** Legacy alias for `currency`. */
        asset: `0x${string}` | Assets.KnownAsset
        /** Token contract address or known x402 asset metadata. */
        currency?: `0x${string}` | Assets.KnownAsset | undefined
      }

  type RecipientConfig =
    | {
        /** Recipient wallet address. */
        recipient: `0x${string}`
        /** Legacy alias for `recipient`. */
        payTo?: `0x${string}` | undefined
      }
    | {
        /** Legacy alias for `recipient`. */
        payTo: `0x${string}`
        /** Recipient wallet address. */
        recipient?: `0x${string}` | undefined
      }

  type Defaults = {
    asset: `0x${string}`
    decimals: number
    maxTimeoutSeconds: number
    network: Types.EvmNetwork
    payTo: `0x${string}`
    transfer: Types.ExactTransfer
  }

  type RouteOptions = {
    /** Required atomic token amount. */
    amount: string
    /** Optional x402 resource metadata for the protected route. */
    resource?: Types.ResourceInfo | undefined
  }
}

type ResolvedConfig = exact.Defaults & {
  facilitator: string | Types.Facilitator
}

function resolveConfig(config: exact.Config): ResolvedConfig {
  const currency = config.currency ?? config.asset
  const recipient = config.recipient ?? config.payTo
  if (!currency) throw new Error('x402 exact requires `currency`.')
  if (!recipient) throw new Error('x402 exact requires `recipient`.')

  let address: `0x${string}`
  let decimals = config.decimals
  let network = config.network
  let transfer = config.transfer

  if (Assets.isAsset(currency)) {
    address = currency.address
    decimals ??= currency.decimals
    network ??= currency.network
    transfer ??= currency.transfer
  } else {
    address = currency
  }

  if (decimals === undefined) throw new Error('x402 exact custom currencies require `decimals`.')
  if (!network) throw new Error('x402 exact custom currencies require `network`.')
  if (!transfer) throw new Error('x402 exact custom currencies require `transfer`.')

  return {
    asset: address,
    decimals,
    facilitator: config.facilitator,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 60,
    network,
    payTo: recipient,
    transfer,
  }
}

function resolveFacilitator(facilitator: string | Types.Facilitator): Types.Facilitator {
  if (typeof facilitator === 'object' && facilitator !== null) return facilitator
  if (typeof facilitator === 'string') return httpFacilitator(facilitator)
  throw new Error('x402 exact requires `facilitator`.')
}

function httpFacilitator(url: string): Types.Facilitator {
  const base = url.replace(/\/$/, '')
  return {
    async verify(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/verify`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.VerifyResponseSchema.parse(await response.json())
    },
    async settle(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/settle`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.SettleResponseSchema.parse(await response.json())
    },
  }
}
