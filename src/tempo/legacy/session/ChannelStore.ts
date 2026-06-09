/**
 * Legacy contract-backed session channel-store facade.
 *
 * Legacy code imports channel-store types and helpers from this module so the
 * contract-backed backend stays rooted under `tempo/legacy`. The underlying
 * store adapter is shared with the TIP-1034 implementation because both
 * backends persist the same accounting counters.
 */
import type * as SharedChannelStore from '../../session/server/ChannelStore.js'

export {
  deductFromChannel,
  fromStore,
  normalizeChannelId,
  type BackendState,
  type BaseState,
  type ChannelStore,
  type DeductResult,
  type State,
} from '../../session/server/ChannelStore.js'

/** State for a legacy smart-contract-backed payment channel. */
export interface LegacyContractBackendState {
  /** Channel backend. Omitted for existing legacy records. */
  backend?: 'contract' | undefined
}

/** @deprecated Use {@link LegacyContractBackendState}. */
export type ContractBackendState = LegacyContractBackendState

/** Legacy contract-backed channel state persisted by `tempo.sessionLegacy`. */
export type LegacyState = SharedChannelStore.BaseState & LegacyContractBackendState

/** Returns whether a channel is backed by the legacy smart contract escrow. */
export function isContractState(
  state: SharedChannelStore.State,
): state is SharedChannelStore.BaseState & LegacyContractBackendState {
  return state.backend === undefined || state.backend === 'contract'
}
