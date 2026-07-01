import type { Address, Client } from 'viem'
import { readContract } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'
import type { dex as viem_dex, token as viem_token } from 'viem/tempo/actions'

import * as TempoAddress from './address.js'
import * as defaults from './defaults.js'

/** Basis-point denominator (100% = 10 000 bps). */
const bps = 10_000n

/** Default fallback currencies for auto-swap, in priority order. */
export const defaultCurrencies: readonly Address[] = [
  defaults.tokens.pathUsd as Address,
  defaults.tokens.usdc as Address,
]

// TODO: Remove once the minimum viem version is >=2.54.0, which uses client-first Tempo call builders.
function getBalanceCall(
  client: Client,
  parameters: viem_token.getBalance.Args,
): ReturnType<typeof viem_token.getBalance.call> {
  const call = Actions.token.getBalance.call as unknown as {
    length: number
    (parameters: viem_token.getBalance.Args): ReturnType<typeof viem_token.getBalance.call>
    (
      client: Client,
      parameters: viem_token.getBalance.Args,
    ): ReturnType<typeof viem_token.getBalance.call>
  }
  return call.length >= 2 ? call(client, parameters) : call(parameters)
}

// TODO: Remove once the minimum viem version is >=2.54.0, which uses client-first Tempo call builders.
function getApproveCall(
  client: Client,
  parameters: viem_token.approve.Args,
): ReturnType<typeof viem_token.approve.call> {
  const call = Actions.token.approve.call as unknown as {
    length: number
    (parameters: viem_token.approve.Args): ReturnType<typeof viem_token.approve.call>
    (
      client: Client,
      parameters: viem_token.approve.Args,
    ): ReturnType<typeof viem_token.approve.call>
  }
  return call.length >= 2 ? call(client, parameters) : call(parameters)
}

// TODO: Remove once the minimum viem version is >=2.54.0, which uses client-first Tempo call builders.
function getBuyCall(
  client: Client,
  parameters: viem_dex.buy.Args,
): ReturnType<typeof viem_dex.buy.call> {
  const call = Actions.dex.buy.call as unknown as {
    length: number
    (parameters: viem_dex.buy.Args): ReturnType<typeof viem_dex.buy.call>
    (client: Client, parameters: viem_dex.buy.Args): ReturnType<typeof viem_dex.buy.call>
  }
  return call.length >= 2 ? call(client, parameters) : call(parameters)
}

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

  const candidates = tokenIn.filter((t) => !TempoAddress.isEqual(t, tokenOut))

  const balanceResults = await Promise.allSettled([
    readContract(client, getBalanceCall(client, { account, token: tokenOut }) as never),
    ...candidates.map((t) =>
      readContract(client, getBalanceCall(client, { account, token: t }) as never),
    ),
  ])

  // If the account already has enough of the target token, no swap needed.
  const targetBalance = balanceResults[0]!
  if (targetBalance.status === 'fulfilled' && (targetBalance.value as bigint) >= amountOut)
    return undefined

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
        amountOut,
      })

      if (balance >= quotedAmountIn) {
        const maxAmountIn =
          quotedAmountIn + (quotedAmountIn * BigInt(Math.round(slippage * 100))) / bps
        return [
          getApproveCall(client, {
            amount: maxAmountIn,
            spender: Addresses.stablecoinDex,
            token: tokenIn,
          }),
          getBuyCall(client, {
            tokenIn,
            tokenOut,
            amountOut,
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
        ...defaultCurrencies.filter((d) => !value.tokenIn!.some((c) => TempoAddress.isEqual(c, d))),
      ]
    : defaultCurrencies
  return {
    tokenIn,
    slippage: value.slippage ?? 1,
  }
}

export declare namespace resolve {
  type Options = {
    /** Fallback tokens to try swapping from, in priority order. */
    tokenIn?: Address[] | undefined
    /** Max slippage tolerance as a percentage (e.g. `1` = 1%). @default 1 */
    slippage?: number | undefined
  }

  type Value = boolean | Options

  type Resolved = { tokenIn: readonly Address[]; slippage: number }
}

export class InsufficientFundsError extends Error {
  override readonly name = 'InsufficientFundsError'

  constructor({ currency }: { currency: Address }) {
    super(
      `Insufficient funds: no balance in ${currency} and no viable swap route from fallback currencies.`,
    )
  }
}
