import type { ResolvedToken } from 'viem'
import type { Token as viem_Token } from 'viem/tokens'

import type * as Challenge from '../Challenge.js'
import * as Constants from '../Constants.js'
import * as x402_Types from '../internal/x402/Types.js'
import * as Receipt_ from '../Receipt.js'

/** An amount in a reference currency, such as `{ value: '0.50', currency: 'USD' }`. */
export type Money = Readonly<{
  /** Non-negative decimal string, such as `'0.50'`. */
  value: string
  /** Reference currency, such as `'USD'`; compared case-insensitively. */
  currency: string
}>

/** An amount of one asset on one network, in its atomic units. */
export type AssetLimit = Readonly<{
  /** Network the asset is paid on: `eip155:<chainId>` for Tempo and EVM, `stripe` for Stripe. */
  network: string
  /** Asset on `network`: a token address (any case), or a Stripe currency such as `usd`. */
  asset: string
  /** Atomic amount. */
  amount: bigint
}>

/**
 * Most a single payment may cost: a {@link Money} limit, or per-asset limits in atomic units.
 *
 * A {@link Money} limit counts only payments in a token whose currency and decimals the client
 * configures itself (`tokens` and Tempo's built-in stablecoins), never values from a challenge.
 * A payment in any other asset is refused.
 */
export type MaxPayment = Money | readonly AssetLimit[]

/**
 * A token the client trusts for currency limits: a `viem/tokens` token (such as `usdc`, on every
 * chain it lists) or a token resolved to one chain (such as `usdc(8453)`), with its `currency`.
 */
export type Token = viem_Token | ResolvedToken

/** The payment a selected challenge asks for, normalized across methods and protocols. */
export type Requirement = Readonly<{
  /** Wire protocol of the challenge. */
  protocol: 'mpp' | 'x402'
  /** Payment method, such as `tempo`, `evm` or `stripe`. */
  method: string
  /** Payment intent: `charge`, the only intent spending options accept. */
  intent: string
  /**
   * Network the payment is on: `eip155:<chainId>` when the challenge's `methodDetails.chainId`
   * names the chain the method signs on, otherwise the method name (such as `stripe`).
   */
  network: string
  /** Asset on `network`: a token address, or a Stripe currency such as `usd`. */
  asset: string
  /** Atomic amount the credential pays in all, `splits` included. */
  amount: bigint
  /**
   * Payee the credential pays: the challenge's `recipient`, or for Stripe the Business Network
   * profile (`methodDetails.networkId`) its Shared Payment Token is created for.
   */
  recipient?: string | undefined
  /**
   * Other payees and their atomic shares, which the credential pays out of `amount`; `recipient`
   * gets the rest.
   */
  splits?: readonly Readonly<{ recipient: string; amount: bigint }>[] | undefined
  /** Reference currency of `asset`, only when the client configures the token. */
  currency?: string | undefined
  /** Decimals of `asset`, only when the client configures the token. */
  decimals?: number | undefined
}>

/** A payment that passed `maxPayment`, handed to `authorize`. mppx issues every plan. */
export type Plan = Readonly<{
  /** The payment the credential would make. */
  requirement: Requirement
}>

/** The paid request a hook runs for. */
export type Context = Readonly<{
  /**
   * A frozen copy of the selected challenge. Server data: never trust it for limits. The
   * credential is signed only if the challenge is unchanged once every hook ran.
   */
  challenge: Challenge.Challenge
  /** The request's abort signal, when it has one. */
  signal?: AbortSignal | undefined
}>

/**
 * Settles one authorized payment. mppx calls one of them, once: `commit` when a credential was
 * created (it may reach the server or move funds), `release` when funding or creating the
 * credential failed, so nothing was signed or sent.
 */
export type Authorization = Readonly<{
  commit(): void
  release(): void
}>

/**
 * Approves a payment after `maxPayment` and before funders run and the credential is signed.
 * Throw to refuse it; return an {@link Authorization} to learn how it settled. Pass a `Budget`
 * to cap total spend across payments.
 */
export type Authorize = (
  plan: Plan,
  context: Context,
) => Authorization | undefined | void | Promise<Authorization | undefined | void>

/**
 * Prepares funds for a payment before its credential is signed, such as swapping or bridging
 * into the paying wallet. Funders run in order after `maxPayment` and `authorize`; if one
 * throws, the authorization is released and the payment fails.
 */
export type Funder = Readonly<{
  fund(requirement: Requirement, context: Context): Promise<void>
}>

/**
 * A decoded protocol receipt from a paid response: an MPP `Payment-Receipt` or an x402
 * `PAYMENT-RESPONSE` that reports success. Server data, so evidence rather than proof.
 */
export type PaymentReceipt = Readonly<{
  /** Protocol of the header it came from. */
  protocol: 'mpp' | 'x402'
  /** Settlement reference: the MPP receipt's `reference` or the x402 `transaction`. */
  reference?: string | undefined
  /** `reference` when it is a 32-byte hex transaction hash. */
  transactionHash?: `0x${string}` | undefined
  /** The decoded header. */
  raw: Readonly<Record<string, unknown>>
}>

/** Longest receipt header decoded; a receipt is a small JSON object. */
const maxReceiptHeaderLength = 8_192

/**
 * Reads the receipt of a paid response: an MPP `Payment-Receipt` header, else an x402
 * `PAYMENT-RESPONSE` header whose `success` is true. Returns `undefined` when the response
 * carries neither, or the header is malformed or oversized.
 *
 * @example
 * ```ts
 * import { Spend } from 'mppx/client'
 *
 * const receipt = Spend.readReceipt(response)
 * receipt?.transactionHash
 * ```
 */
export function readReceipt(response: Response): PaymentReceipt | undefined {
  const mpp = response.headers.get(Constants.Headers.paymentReceipt)
  if (mpp !== null) {
    if (mpp.length > maxReceiptHeaderLength) return undefined
    try {
      const receipt = Receipt_.deserialize(mpp)
      return toReceipt('mpp', receipt.reference, receipt)
    } catch {
      return undefined
    }
  }
  const x402 = response.headers.get(x402_Types.paymentResponseHeader)
  if (x402 === null || x402.length > maxReceiptHeaderLength) return undefined
  try {
    const binary = atob(x402.trim().replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const parsed = x402_Types.SettleResponseSchema.safeParse(json)
    if (!parsed.success || !parsed.data.success) return undefined
    return toReceipt('x402', parsed.data.transaction, json as Record<string, unknown>)
  } catch {
    return undefined
  }
}

function toReceipt(
  protocol: PaymentReceipt['protocol'],
  reference: string,
  raw: Readonly<Record<string, unknown>>,
): PaymentReceipt {
  return Object.freeze({
    protocol,
    ...(reference ? { reference } : {}),
    ...(/^0x[\da-fA-F]{64}$/.test(reference)
      ? { transactionHash: reference as `0x${string}` }
      : {}),
    raw: Object.freeze({ ...raw }),
  })
}
