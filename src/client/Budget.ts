import { PaymentLimitExceededError } from '../Errors.js'
import * as SpendGate from './internal/SpendGate.js'
import type * as Spend from './Spend.js'

/** A budget's total: an amount in a reference currency, or an amount of one asset. */
export type Total = Spend.Money | Spend.AssetLimit

/** The shape of a budget's amounts: {@link Spend.Money} for a currency total, else {@link Spend.AssetLimit}. */
export type Amount<total extends Total> = total extends Spend.Money ? Spend.Money : Spend.AssetLimit

/**
 * A spending cap shared by concurrent payments, usable as the client's `authorize` option. Each
 * payment reserves its amount before it is signed; mppx commits the reservation once the
 * credential is created and releases it when nothing was signed.
 */
export type Budget<total extends Total = Total> = {
  /** Reserves the plan's amount, or throws `PaymentLimitExceededError` when it does not fit. */
  (plan: Spend.Plan, context?: Spend.Context | undefined): Spend.Authorization
  /** The configured total. */
  readonly total: Amount<total>
  /** Total minus spent and reserved amounts. */
  remaining(): Amount<total>
  /** Amounts of payments whose credential was created. */
  spent(): Amount<total>
  /** Amounts held by payments in flight. */
  reserved(): Amount<total>
}

/**
 * Creates a {@link Budget}. Reservations are synchronous, so concurrent payments cannot
 * overspend it.
 *
 * A currency total counts only payments in tokens whose currency and decimals the client
 * configures (`tokens` and Tempo's built-in stablecoins); an asset total counts only payments in
 * that asset. Any other payment is refused.
 *
 * @example
 * ```ts
 * import { Budget, Mppx, tempo } from 'mppx/client'
 *
 * const budget = Budget.create({ total: { value: '5', currency: 'USD' } })
 * const mppx = Mppx.create({ methods: [tempo({ account })], authorize: budget })
 *
 * await mppx.fetch('https://api.example.com/resource')
 * budget.remaining() // { value: '4.99', currency: 'USD' }
 * ```
 */
export function create<const total extends Total>(options: create.Options<total>): Budget<total> {
  const total = { ...options.total } as Total
  const money = !SpendGate.isAssetLimit(total)
  if (money) SpendGate.assertMoney(total, 'total')
  // Money amounts are kept as integers at `scale` decimal places, raised to fit each payment.
  let scale = money ? (total.value.split('.')[1]?.length ?? 0) : 0
  let limit = money ? SpendGate.parseUnits(total.value, scale) : total.amount
  let spent = 0n
  let reserved = 0n
  const rescale = (decimals: number) => {
    if (decimals <= scale) return
    const factor = 10n ** BigInt(decimals - scale)
    limit *= factor
    spent *= factor
    reserved *= factor
    scale = decimals
  }
  const amount = (value: bigint): Total =>
    Object.freeze(
      money
        ? { value: formatUnits(value, scale), currency: total.currency }
        : { network: total.network, asset: total.asset, amount: value },
    )
  const refuse = (reason: PaymentLimitExceededError.Reason) =>
    new PaymentLimitExceededError({ limit: 'budget', reason })

  const authorize = (plan: Spend.Plan) => {
    if (!SpendGate.isIssued(plan)) throw new TypeError('Budget only accepts plans mppx issued.')
    const { requirement } = plan
    let decimals = 0
    if (money) {
      // Set only from client configuration, never from the challenge.
      if (requirement.currency === undefined || requirement.decimals === undefined)
        throw refuse('asset')
      if (requirement.currency.toUpperCase() !== total.currency.toUpperCase()) throw refuse('asset')
      decimals = requirement.decimals
    } else if (
      SpendGate.assetKey(requirement.network, requirement.asset) !==
      SpendGate.assetKey(total.network, total.asset)
    )
      throw refuse('asset')
    rescale(decimals)
    const cost = requirement.amount * 10n ** BigInt(scale - decimals)
    if (cost > limit - spent - reserved) throw refuse('amount')
    reserved += cost
    let open = true
    const close = () => {
      if (!open) return false
      open = false
      reserved -= cost
      return true
    }
    return Object.freeze({
      commit() {
        if (close()) spent += cost
      },
      release() {
        close()
      },
    })
  }
  return Object.freeze(
    Object.assign(authorize, {
      total: amount(limit),
      remaining: () => amount(limit - spent - reserved),
      spent: () => amount(spent),
      reserved: () => amount(reserved),
    }),
  ) as unknown as Budget<total>
}

export declare namespace create {
  type Options<total extends Total = Total> = {
    /** Most the budget lets payments spend. */
    total: total
  }
}

/** Formats an integer at `decimals` places as a decimal string without trailing zeros. */
function formatUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString()
  const digits = value.toString().padStart(decimals + 1, '0')
  const fraction = digits.slice(-decimals).replace(/0+$/, '')
  const integer = digits.slice(0, -decimals)
  return fraction ? `${integer}.${fraction}` : integer
}
