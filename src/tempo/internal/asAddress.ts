import type { Address } from 'viem'
import { isAddress } from 'viem'

/**
 * Validates and narrows a string to `0x${string}`, suitable for use with
 * environment variables where `process.env.*` is typed as `string | undefined`.
 *
 * @example
 * ```ts
 * import { asAddress } from 'mppx/utils'
 * import { tempo } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo({
 *     recipient: asAddress(process.env.MPP_TEMPO_RECIPIENT),
 *     currency: asAddress(process.env.MPP_TEMPO_CURRENCY),
 *   })],
 * })
 * ```
 */
export function asAddress(value: string | undefined): Address {
  if (value === undefined) throw new Error('Expected an address but received undefined.')
  if (!isAddress(value)) throw new Error(`Invalid address: "${value}".`)
  return value
}
