import type { Account } from 'viem'

import type { ConfiguredDefaults } from '../../internal/types.js'

/**
 * Request defaults for a Tempo factory.
 *
 * Includes only caller configuration known to be defined, plus `resolved`
 * values that the factory creates unconditionally before returning its method.
 * This keeps the returned handler's required request fields aligned with the
 * values that will actually exist at runtime.
 */
export type DeriveDefaults<parameters, defaults, resolved extends object = {}> = ConfiguredDefaults<
  parameters,
  defaults
> &
  resolved &
  (parameters extends { account: Account | string } ? { recipient: string } : {}) &
  (parameters extends { recipient: string } ? { recipient: string } : {})
