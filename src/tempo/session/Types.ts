import type { Address, Hex } from 'viem'

/**
 * Voucher for cumulative payment.
 * Cumulative monotonicity prevents replay attacks.
 */
export interface Voucher {
  channelId: Hex
  cumulativeAmount: bigint
}

/**
 * Signed voucher with EIP-712 signature.
 */
export interface SignedVoucher extends Voucher {
  signature: Hex
}

/**
 * Session credential payload (discriminated union).
 */
export type SessionCredentialPayload =
  | {
      action: 'open'
      type: 'transaction'
      channelId: Hex
      transaction: Hex
      signature: Hex
      authorizedSigner?: Address | undefined
      cumulativeAmount: string
    }
  | {
      action: 'topUp'
      type: 'transaction'
      channelId: Hex
      transaction: Hex
      additionalDeposit: string
    }
  | {
      action: 'voucher'
      channelId: Hex
      cumulativeAmount: string
      signature: Hex
    }
  | {
      action: 'close'
      channelId: Hex
      cumulativeAmount: string
      signature: Hex
    }

/**
 * Optional session state hints carried in `challenge.request.methodDetails`.
 *
 * These fields are additive reconciliation hints, not protocol requirements.
 * Amounts are serialized in raw base units so clients can reuse them directly.
 */
export interface SessionChallengeMethodDetails {
  acceptedCumulative?: string | undefined
  chainId?: number | undefined
  channelId?: Hex | undefined
  deposit?: string | undefined
  escrowContract?: Address | undefined
  feePayer?: boolean | undefined
  minVoucherDelta?: string | undefined
  requiredCumulative?: string | undefined
  spent?: string | undefined
}

/**
 * SSE event emitted when session balance is exhausted mid-stream.
 * The client responds by sending a new voucher credential.
 *
 * Per spec §11.6, the event data contains:
 * - `channelId` — channel identifier
 * - `requiredCumulative` — minimum cumulative amount the next voucher must authorize
 * - `acceptedCumulative` — current highest accepted voucher amount
 * - `deposit` — current on-chain deposit ceiling; when `requiredCumulative > deposit`
 *   the client must top up the channel before sending a new voucher
 */
export interface NeedVoucherEvent {
  channelId: Hex
  requiredCumulative: string
  acceptedCumulative: string
  deposit: string
}

/**
 * Session receipt returned in Payment-Receipt header.
 */
export interface SessionReceipt {
  method: 'tempo'
  intent: 'session'
  status: 'success'
  timestamp: string
  /** Payment reference (channelId). Satisfies Receipt.Receipt contract. */
  reference: string
  challengeId: string
  channelId: Hex
  acceptedCumulative: string
  spent: string
  units?: number | undefined
  txHash?: Hex | undefined
}
