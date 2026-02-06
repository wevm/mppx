import type { Address, Hex } from 'viem'
import type { SignedVoucher } from './Types.js'

/**
 * Channel state tracked by the server.
 */
export interface ChannelState {
  channelId: Hex
  payer: Address
  payee: Address
  token: Address
  authorizedSigner: Address
  deposit: bigint
  highestVoucherAmount: bigint
  highestVoucher: SignedVoucher | null
  createdAt: Date
}

/**
 * Session state for per-challenge accounting.
 */
export interface SessionState {
  challengeId: string
  channelId: Hex
  acceptedCumulative: bigint
  spent: bigint
  units: number
  createdAt: Date
}

/**
 * Storage interface for channel state persistence.
 *
 * Uses atomic update callbacks for read-modify-write safety.
 * Backends implement atomicity via their native mechanisms
 * (JS single-thread, DO single-thread, D1 transactions, etc.).
 */
export interface ChannelStorage {
  getChannel(channelId: Hex): Promise<ChannelState | null>
  getSession(challengeId: string): Promise<SessionState | null>

  /** Atomic read-modify-write for channel state. Return null to delete. */
  updateChannel(
    channelId: Hex,
    fn: (current: ChannelState | null) => ChannelState | null,
  ): Promise<ChannelState | null>

  /** Atomic read-modify-write for session state. Return null to delete. */
  updateSession(
    challengeId: string,
    fn: (current: SessionState | null) => SessionState | null,
  ): Promise<SessionState | null>
}
