import type { Address, ResolvedToken } from 'viem'
import type { Token } from 'viem/tokens'

/**
 * A currency accepted anywhere mppx takes one: a token address, a chain-indexed token from
 * `viem/tokens` (such as `ousd`), or a token resolved to one chain (such as `ousd(4217)`).
 *
 * @example
 * ```ts
 * import { ousd, usdc } from 'viem/tokens'
 *
 * const currencies = [ousd, usdc(8453), '0x20c0000000000000000000000000000000000000']
 * ```
 */
export type Currency = Address | Token | ResolvedToken

/** A currency resolved to one chain. `decimals` is `undefined` for an address configured without decimals. */
export type Resolved = Omit<ResolvedToken, 'decimals'> & { decimals: number | undefined }

/** Returns true when a value is a chain-indexed token from `viem/tokens`. */
export function isToken(value: unknown): value is Token {
  return (
    typeof value === 'function' &&
    typeof (value as Partial<Token>).addresses === 'object' &&
    typeof (value as Partial<Token>).decimals === 'number'
  )
}

/** Returns true when a value is a token resolved to one chain, such as `ousd(4217)`. */
export function isResolvedToken(value: unknown): value is ResolvedToken {
  if (typeof value !== 'object' || value === null) return false
  const { address, chainId, decimals } = value as Partial<ResolvedToken>
  return typeof address === 'string' && typeof chainId === 'number' && typeof decimals === 'number'
}

/** Returns the chain a currency is bound to: a resolved token's `chainId`, otherwise `undefined`. */
export function chainIdOf(currency: Currency): number | undefined {
  return isResolvedToken(currency) ? currency.chainId : undefined
}

/**
 * Returns the decimals every token in `currencies` shares, or `undefined` when the list has no
 * tokens or its tokens disagree. Addresses carry no decimals and are ignored.
 */
export function decimalsOf(currencies: readonly Currency[] | undefined): number | undefined {
  let decimals: number | undefined
  for (const currency of currencies ?? []) {
    if (typeof currency === 'string') continue
    if (decimals !== undefined && decimals !== currency.decimals) return undefined
    decimals = currency.decimals
  }
  return decimals
}

/**
 * Resolves a currency for `chainId`: a token by its addresses, a resolved token only on its own
 * chain, and an address on any chain with `decimals`. Returns `undefined` when the currency has no
 * address on `chainId`.
 */
export function resolve(currency: Currency, options: resolve.Options): Resolved | undefined {
  const { chainId, decimals } = options
  if (typeof currency === 'string') return { address: currency, chainId, decimals }
  if (isToken(currency)) {
    if (!(currency.addresses as Record<number, Address | undefined>)[chainId]) return undefined
    return currency(chainId as never)
  }
  if (currency.chainId !== chainId) return undefined
  return currency
}

export declare namespace resolve {
  type Options = {
    /** Chain to resolve the currency for. */
    chainId: number
    /** Decimals of an address currency. Tokens carry their own. */
    decimals?: number | undefined
  }
}

/**
 * Returns the first currency in `currencies` that is `address`, compared case-insensitively, with
 * its decimals: an address as is, and a token on `chainId`, or on any chain it lists when
 * `chainId` is omitted.
 */
export function find(
  currencies: readonly Currency[],
  address: string,
  options: find.Options = {},
): find.ReturnType | undefined {
  const { chainId, decimals } = options
  const matches = (value: string) => value.toLowerCase() === address.toLowerCase()
  for (const currency of currencies) {
    if (typeof currency === 'string') {
      if (matches(currency)) return { currency, decimals }
      continue
    }
    const candidates =
      chainId !== undefined
        ? [resolve(currency, { chainId })]
        : isToken(currency)
          ? Object.keys(currency.addresses).map((id) => resolve(currency, { chainId: Number(id) }))
          : [currency]
    if (candidates.some((candidate) => candidate && matches(candidate.address)))
      return { currency, decimals: currency.decimals }
  }
  return undefined
}

export declare namespace find {
  type Options = {
    /** Chain the address is on. When omitted, tokens match on any chain they list. */
    chainId?: number | undefined
    /** Decimals of an address currency. Tokens carry their own. */
    decimals?: number | undefined
  }

  type ReturnType = {
    /** The matching currency. */
    currency: Currency
    /** Its decimals: the token's, or the configured `decimals` for an address. */
    decimals: number | undefined
  }
}
