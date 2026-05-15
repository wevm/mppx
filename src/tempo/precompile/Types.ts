import type { Address, Hex } from 'viem'

const maxUint96 = (1n << 96n) - 1n

/** Amount encoded by TIP20EscrowChannel as a `uint96` on-chain value. */
export type Uint96 = bigint

/** Returns whether a bigint can be encoded as a TIP20EscrowChannel `uint96` amount. */
export function isUint96(value: bigint): value is Uint96 {
  return value >= 0n && value <= maxUint96
}

/** Converts a bigint into a TIP20EscrowChannel `uint96` amount after validating bounds. */
export function uint96(value: bigint): Uint96 {
  assertUint96(value)
  return value
}

/** Asserts that a bigint can be encoded as a TIP20EscrowChannel `uint96` amount. */
export function assertUint96(value: bigint): void {
  if (!isUint96(value)) throw new Error(`Value ${value} is outside uint96 bounds.`)
}

export type ChannelDescriptor = {
  payer: Address
  payee: Address
  operator: Address
  token: Address
  salt: Hex
  authorizedSigner: Address
  expiringNonceHash: Hex
}

/**
 * Voucher for cumulative payment.
 * Cumulative monotonicity prevents replay attacks.
 */
export type Voucher = {
  channelId: Hex
  cumulativeAmount: bigint
}

/**
 * Signed voucher with EIP-712 signature.
 */
export type SignedVoucher = Voucher & { signature: Hex }

/**
 * TIP20EscrowChannel precompile session credential payload (discriminated union).
 */
export type SessionCredentialPayload =
  | {
      action: 'open'
      type: 'transaction'
      channelId: Hex
      transaction: Hex
      signature: Hex
      descriptor: ChannelDescriptor
      cumulativeAmount: string
      authorizedSigner?: Address | undefined
    }
  | {
      action: 'topUp'
      type: 'transaction'
      channelId: Hex
      transaction: Hex
      descriptor: ChannelDescriptor
      additionalDeposit: string
    }
  | {
      action: 'voucher'
      channelId: Hex
      descriptor: ChannelDescriptor
      cumulativeAmount: string
      signature: Hex
    }
  | {
      action: 'close'
      channelId: Hex
      descriptor: ChannelDescriptor
      cumulativeAmount: string
      signature: Hex
    }
