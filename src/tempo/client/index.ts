import type { Account, Address } from 'viem'
import type * as MethodIntent from '../../MethodIntent.js'
import type * as Client from '../../viem/Client.js'
import { charge } from './Charge.js'
import { stream } from './Stream.js'

export { charge } from './Charge.js'
export { stream } from './Stream.js'

/**
 * Creates both Tempo charge and stream client method intents.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/client'
 *
 * const mpay = Mpay.create({
 *   methods: tempo({ account }),
 * })
 * ```
 */
export function tempo(
  parameters: tempo.Parameters = {},
): readonly [MethodIntent.AnyClient, MethodIntent.AnyClient] {
  const { deposit, escrowContract, ...shared } = parameters
  return [charge(shared), stream({ ...shared, deposit, escrowContract })] as const
}

export declare namespace tempo {
  type Parameters = Client.getResolver.Parameters & {
    /** Account to sign transactions/vouchers with. Can be overridden per-call via context. */
    account?: Account | undefined
    /** Initial deposit amount for auto-managed stream channels. */
    deposit?: bigint | undefined
    /** Escrow contract address override for streams. */
    escrowContract?: Address | undefined
  }
}
