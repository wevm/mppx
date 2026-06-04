import type { Address, Hex } from 'viem'

import type { SessionSignedVoucher, SessionVoucher } from '../../session/precompile/Protocol.js'

/**
 * Legacy credential payload that opens a smart-contract-backed channel and authorizes initial spend.
 */
export type LegacyOpenCredentialPayload = {
  action: 'open'
  type: 'transaction'
  /** Session channel ID. */
  channelId: Hex
  /** Signed transaction containing the channel-open call. */
  transaction: Hex
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
  /** Voucher signer selected for the opened channel. */
  authorizedSigner?: Address | undefined
  /** Initial cumulative spend authorized by the opening voucher, as raw units. */
  cumulativeAmount: string
}

/** Legacy credential payload that adds deposit to an existing smart-contract-backed channel. */
export type LegacyTopUpCredentialPayload = {
  action: 'topUp'
  type: 'transaction'
  /** Session channel ID being topped up. */
  channelId: Hex
  /** Signed transaction containing the channel top-up call. */
  transaction: Hex
  /** Additional deposit to add, as raw units. */
  additionalDeposit: string
}

/** Legacy credential payload that increases cumulative spend authorization. */
export type LegacyVoucherCredentialPayload = {
  action: 'voucher'
  /** Session channel ID the voucher applies to. */
  channelId: Hex
  /** Highest cumulative spend authorized by this voucher, as raw units. */
  cumulativeAmount: string
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
}

/** Legacy credential payload that cooperatively closes a channel at final cumulative spend. */
export type LegacyCloseCredentialPayload = {
  action: 'close'
  /** Session channel ID being closed. */
  channelId: Hex
  /** Final cumulative spend authorized at close, as raw units. */
  cumulativeAmount: string
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
}

/**
 * Legacy smart-contract-backed session credential payload.
 */
export type LegacySessionCredentialPayload =
  | LegacyOpenCredentialPayload
  | LegacyTopUpCredentialPayload
  | LegacyVoucherCredentialPayload
  | LegacyCloseCredentialPayload

/** Legacy smart-contract-backed voucher for cumulative payment. */
export type LegacyVoucher = SessionVoucher

/** Legacy smart-contract-backed voucher with EIP-712 signature. */
export type LegacySignedVoucher = SessionSignedVoucher

/** @deprecated Use {@link LegacyVoucher}. */
export type Voucher = LegacyVoucher

/** @deprecated Use {@link LegacySignedVoucher}. */
export type SignedVoucher = LegacySignedVoucher

/** @deprecated Use {@link LegacyOpenCredentialPayload}. */
export type OpenCredentialPayload = LegacyOpenCredentialPayload

/** @deprecated Use {@link LegacyTopUpCredentialPayload}. */
export type TopUpCredentialPayload = LegacyTopUpCredentialPayload

/** @deprecated Use {@link LegacyVoucherCredentialPayload}. */
export type VoucherCredentialPayload = LegacyVoucherCredentialPayload

/** @deprecated Use {@link LegacyCloseCredentialPayload}. */
export type CloseCredentialPayload = LegacyCloseCredentialPayload

/** @deprecated Use {@link LegacySessionCredentialPayload}. */
export type SessionCredentialPayload = LegacySessionCredentialPayload
