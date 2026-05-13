import type { Address, Hex } from 'viem'

import type * as Channel from './Channel.js'

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

/** TIP-1034 precompile open credential payload before amount branding. */
export type OpenCredentialPayload = {
  action: 'open'
  type: 'transaction'
  channelId: Hex
  transaction: Hex
  signature: Hex
  descriptor: Channel.ChannelDescriptor
  cumulativeAmount: string
  authorizedSigner?: Address | undefined
}

/** TIP-1034 precompile top-up credential payload before amount branding. */
export type TopUpCredentialPayload = {
  action: 'topUp'
  type: 'transaction'
  channelId: Hex
  transaction: Hex
  descriptor: Channel.ChannelDescriptor
  additionalDeposit: string
}

/** TIP-1034 precompile voucher credential payload before amount branding. */
export type VoucherCredentialPayload = {
  action: 'voucher'
  channelId: Hex
  descriptor: Channel.ChannelDescriptor
  cumulativeAmount: string
  signature: Hex
}

/** TIP-1034 precompile close credential payload before amount branding. */
export type CloseCredentialPayload = {
  action: 'close'
  channelId: Hex
  descriptor: Channel.ChannelDescriptor
  cumulativeAmount: string
  signature: Hex
}

/** TIP-1034 precompile session credential payload before amount branding. */
export type SessionCredentialPayload =
  | OpenCredentialPayload
  | TopUpCredentialPayload
  | VoucherCredentialPayload
  | CloseCredentialPayload

export type ParsedOpenCredentialPayload = Omit<OpenCredentialPayload, 'cumulativeAmount'> & {
  cumulativeAmount: Uint96
}

export type ParsedTopUpCredentialPayload = Omit<TopUpCredentialPayload, 'additionalDeposit'> & {
  additionalDeposit: Uint96
}

export type ParsedVoucherCredentialPayload = Omit<VoucherCredentialPayload, 'cumulativeAmount'> & {
  cumulativeAmount: Uint96
}

export type ParsedCloseCredentialPayload = Omit<CloseCredentialPayload, 'cumulativeAmount'> & {
  cumulativeAmount: Uint96
}

/** TIP-1034 precompile session credential payload after boundary validation. */
export type ParsedSessionCredentialPayload =
  | ParsedOpenCredentialPayload
  | ParsedTopUpCredentialPayload
  | ParsedVoucherCredentialPayload
  | ParsedCloseCredentialPayload

export function parseCredentialPayload(payload: OpenCredentialPayload): ParsedOpenCredentialPayload
export function parseCredentialPayload(
  payload: TopUpCredentialPayload,
): ParsedTopUpCredentialPayload
export function parseCredentialPayload(
  payload: VoucherCredentialPayload,
): ParsedVoucherCredentialPayload
export function parseCredentialPayload(
  payload: CloseCredentialPayload,
): ParsedCloseCredentialPayload
/** Parses and brands decimal string amounts from a precompile session credential payload. */
export function parseCredentialPayload(
  payload: SessionCredentialPayload,
): ParsedSessionCredentialPayload {
  if (payload.action === 'topUp') {
    return {
      ...payload,
      additionalDeposit: parseUint96Amount(payload.additionalDeposit),
    }
  }

  return {
    ...payload,
    cumulativeAmount: parseUint96Amount(payload.cumulativeAmount),
  }
}

/** Parses a decimal string into a TIP-1034 `uint96` amount. */
export function parseUint96Amount(value: string): Uint96 {
  if (!/^\d+$/.test(value)) throw new Error('Expected uint96 amount as a decimal string.')
  return uint96(BigInt(value))
}
