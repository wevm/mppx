const maxUint96 = (1n << 96n) - 1n
declare const uint96Brand: unique symbol

/** Bigint branded as already validated to fit the TIP-1034 `uint96` amount width. */
export type Uint96 = bigint & { readonly [uint96Brand]: true }

/** Returns whether a bigint can be encoded as a TIP-1034 `uint96` amount. */
export function isUint96(value: bigint): value is Uint96 {
  return value >= 0n && value <= maxUint96
}

/** Converts a bigint into a branded TIP-1034 `uint96` amount. */
export function uint96(value: bigint): Uint96 {
  if (!isUint96(value)) throw new Error(`Value ${value} is outside uint96 bounds.`)
  return value
}

/** Asserts that a bigint can be encoded as a TIP-1034 `uint96` amount. */
export function assertUint96(value: bigint): asserts value is Uint96 {
  uint96(value)
}
