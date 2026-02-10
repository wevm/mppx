import type { Address, Hex } from 'viem'
import type { SignedVoucher } from './Types.js'

/**
 * Long-lived state for an on-chain payment channel.
 *
 * Tracks the channel's identity, on-chain balance, and the highest voucher
 * the server has accepted. A channel is created when a payer opens an escrow
 * on-chain and persists until the channel is finalized (closed/settled).
 *
 * One channel may back many sessions over its lifetime.
 *
 * Monotonicity invariants (enforced by update callbacks):
 * - `highestVoucherAmount` only increases
 * - `settledOnChain` only increases
 * - `deposit` reflects the latest on-chain value
 */
export interface ChannelState {
  channelId: Hex
  payer: Address
  payee: Address
  token: Address
  authorizedSigner: Address

  /** Current on-chain deposit in the escrow contract. */
  deposit: bigint
  /** Cumulative amount settled on-chain so far. */
  settledOnChain: bigint
  /** Highest cumulative voucher amount accepted by the server. */
  highestVoucherAmount: bigint
  /** The signed voucher corresponding to `highestVoucherAmount`. */
  highestVoucher: SignedVoucher | null

  /** Challenge ID of the currently active session, if any. */
  activeSessionId?: string | undefined
  /** Whether the channel has been finalized (closed) on-chain. */
  finalized: boolean
  createdAt: Date
}

/**
 * Short-lived state for per-challenge accounting within a channel.
 *
 * Each 402 challenge creates a session that tracks how much of the channel's
 * voucher balance has been consumed by API requests. This separates the
 * channel's total accepted balance from what a specific authorization flow
 * has actually spent.
 *
 * ```
 * Channel (long-lived)         Session (per-challenge)
 * ┌──────────────────┐         ┌──────────────────────┐
 * │ deposit: 100     │         │ acceptedCumulative: 50│ ← from voucher
 * │ highestVoucher:50│ ──1:N──>│ spent: 30            │ ← consumed by requests
 * │ settledOnChain: 0│         │ available: 20        │ ← (computed)
 * └──────────────────┘         │ units: 15            │ ← request count
 *                              └──────────────────────┘
 * ```
 *
 * Monotonicity invariant: `acceptedCumulative` only increases.
 */
export interface SessionState {
  /** The challenge ID that created this session (also the lookup key). */
  challengeId: string
  /** The channel this session draws balance from. */
  channelId: Hex
  /** Cumulative voucher amount accepted into this session. */
  acceptedCumulative: bigint
  /** Cumulative amount spent (charged) against this session. */
  spent: bigint
  /** Number of charge operations (API requests) fulfilled. */
  units: number
  createdAt: Date
}

/**
 * Storage interface for channel and session state persistence.
 *
 * ## Why two state types?
 *
 * **Channels** are long-lived and map 1:1 to on-chain escrow contracts.
 * They track deposits, vouchers, and settlement — things that persist
 * across multiple authorization flows.
 *
 * **Sessions** are short-lived and map 1:1 to 402 challenges. They track
 * how much balance a specific authorization flow has consumed. This lets
 * the server issue multiple challenges against the same channel without
 * conflating their accounting.
 *
 * ## Atomicity contract
 *
 * The `update*` methods use atomic read-modify-write callbacks. The callback
 * receives the current state (or `null` if none exists), and returns the
 * next state (or `null` to delete). Implementations must guarantee that no
 * concurrent mutation occurs between reading `current` and writing the
 * return value.
 *
 * Backends implement this via their native mechanisms:
 * - **In-memory / JS single-thread**: Synchronous callback execution
 * - **Durable Objects**: Single-threaded execution model
 * - **D1 / SQL**: Database transactions
 */
export interface ChannelStorage {
  getChannel(channelId: Hex): Promise<ChannelState | null>
  getSession(challengeId: string): Promise<SessionState | null>

  /**
   * Atomic read-modify-write for channel state.
   * Return `null` from `fn` to delete the channel.
   */
  updateChannel(
    channelId: Hex,
    fn: (current: ChannelState | null) => ChannelState | null,
  ): Promise<ChannelState | null>

  /**
   * Atomic read-modify-write for session state.
   * Return `null` from `fn` to delete the session.
   */
  updateSession(
    challengeId: string,
    fn: (current: SessionState | null) => SessionState | null,
  ): Promise<SessionState | null>
}
