import type { Address, Client } from 'viem'
import { readContract } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'

import * as TempoAddress from './address.js'
import * as defaults from './defaults.js'

/** Basis-point denominator (100% = 10 000 bps). */
const bps = 10_000n

/** Default fallback currencies for auto-swap, in priority order. */
export const defaultCurrencies: readonly Address[] = [
  defaults.tokens.pathUsd as Address,
  defaults.tokens.usdc as Address,
  defaults.tokens.ousd as Address,
]

/**
 * Finds the optimal swap calls to acquire `amountOut` of `tokenOut`,
 * returning an approve + buy call sequence if a viable route is found.
 *
 * Returns `undefined` if the account already holds enough of `tokenOut`
 * or no viable swap route exists from the given input tokens.
 */
export async function findCalls(
  client: Client,
  parameters: findCalls.Parameters,
): Promise<findCalls.ReturnType> {
  const { account, amountOut, tokenOut, tokenIn, slippage } = parameters
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 50)
    throw new Error('Auto-swap slippage must be between 0 and 50 percent.')
  if (parameters.maxAmountIn !== undefined && parameters.maxAmountIn <= 0n)
    throw new Error('Auto-swap maxAmountIn must be positive.')

  const candidates = tokenIn.filter((t) => !TempoAddress.isEqual(t, tokenOut))

  const balanceResults = await Promise.allSettled([
    readContract(
      client,
      Actions.token.getBalance.call(client, { account, token: tokenOut }) as never,
    ),
    ...candidates.map((t) =>
      readContract(client, Actions.token.getBalance.call(client, { account, token: t }) as never),
    ),
  ])

  // If the account already has enough of the target token, no swap needed.
  const targetBalance = balanceResults[0]!
  if (targetBalance.status !== 'fulfilled') throw targetBalance.reason
  const held = targetBalance.value as bigint
  if (held >= amountOut) return undefined
  const deficit = amountOut - held
  const slippageBps = BigInt(Math.round(slippage * 100))
  // Bound price independently of the DEX quote. Stablecoin units default to parity.
  const spendLimit = parameters.maxAmountIn ?? deficit + (deficit * slippageBps) / bps

  // Find first candidate with enough balance to cover a swap.
  for (let i = 0; i < candidates.length; i++) {
    const result = balanceResults[i + 1]!
    if (result.status !== 'fulfilled') continue

    const balance = result.value as bigint
    if (balance <= 0n) continue

    const tokenIn = candidates[i]!

    try {
      const quotedAmountIn = await Actions.dex.getBuyQuote(client as never, {
        tokenIn,
        tokenOut,
        amountOut: deficit,
      })

      if (quotedAmountIn <= 0n || quotedAmountIn > spendLimit) continue
      const quotedLimit = quotedAmountIn + (quotedAmountIn * slippageBps) / bps
      const maxAmountIn = quotedLimit < spendLimit ? quotedLimit : spendLimit
      if (balance >= maxAmountIn) {
        return [
          Actions.token.approve.call(client, {
            amount: maxAmountIn,
            spender: Addresses.stablecoinDex,
            token: tokenIn,
          }),
          Actions.dex.buy.call({
            tokenIn,
            tokenOut,
            amountOut: deficit,
            maxAmountIn,
          }),
        ]
      }
    } catch {}
  }

  throw new InsufficientFundsError({ currency: tokenOut })
}

export declare namespace findCalls {
  type Parameters = {
    /** Address of the account to check balances for. */
    account: Address
    /** Amount of the target token needed. */
    amountOut: bigint
    /** Candidate input tokens to swap from, in priority order. */
    tokenIn: readonly Address[]
    /** Maximum input-token units to spend. Defaults to the missing output amount plus slippage (1:1 units). */
    maxAmountIn?: bigint | undefined
    /** Max slippage tolerance as a percentage (e.g. `1` = 1%). */
    slippage: number
    /** Address of the target token to acquire. */
    tokenOut: Address
  }

  /** `undefined` when no swap is needed (account has sufficient balance). */
  type ReturnType = readonly object[] | undefined
}

/** Resolves an auto-swap configuration value into concrete currencies and slippage. */
export function resolve(
  value: resolve.Value | undefined,
  defaultCurrencies: readonly Address[],
): resolve.Resolved | false {
  if (!value) return false
  if (value === true) return { tokenIn: defaultCurrencies, slippage: 1 }
  const tokenIn = value.tokenIn
    ? [
        ...value.tokenIn,
        ...(value.fallback === false
          ? []
          : defaultCurrencies.filter(
              (d) => !value.tokenIn!.some((c) => TempoAddress.isEqual(c, d)),
            )),
      ]
    : defaultCurrencies
  return {
    tokenIn,
    slippage: value.slippage ?? 1,
    ...(value.maxAmountIn !== undefined ? { maxAmountIn: value.maxAmountIn } : {}),
  }
}

export declare namespace resolve {
  type Options = {
    /** Maximum input-token units per swap. Defaults to parity with the missing output amount plus slippage; set explicitly for non-parity pairs. */
    maxAmountIn?: bigint | undefined
    /** Fallback tokens to try swapping from, in priority order. */
    tokenIn?: Address[] | undefined
    /**
     * Whether to also try the default currencies after `tokenIn`. Set `false` to swap only from
     * `tokenIn`, as an allowlist. Ignored without `tokenIn`. @default true
     */
    fallback?: boolean | undefined
    /** Max slippage tolerance as a percentage (e.g. `1` = 1%). @default 1 */
    slippage?: number | undefined
  }

  type Value = boolean | Options

  type Resolved = {
    tokenIn: readonly Address[]
    slippage: number
    maxAmountIn?: bigint | undefined
  }
}

export class InsufficientFundsError extends Error {
  override readonly name = 'InsufficientFundsError'

  constructor({ currency }: { currency: Address }) {
    super(
      `Insufficient funds: no balance in ${currency} and no viable swap route from fallback currencies.`,
    )
  }
}
