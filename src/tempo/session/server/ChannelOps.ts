import type { Address, Hex } from 'viem'
import { decodeFunctionData, isAddressEqual } from 'viem'

import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import type { Uint96 } from '../precompile/Protocol.js'
import { uint96 } from '../precompile/Protocol.js'

/** Optional expected values used to validate a TIP-1034 `open` calldata payload. */
export type ParseOpenCallExpected = {
  authorizedSigner?: Address | undefined
  deposit?: Uint96 | undefined
  operator?: Address | undefined
  payee?: Address | undefined
  token?: Address | undefined
}

/** Input for parsing and validating TIP-1034 `open` calldata. */
export type ParseOpenCallParameters = {
  data: Hex
  expected?: ParseOpenCallExpected | undefined
}

/** Decoded and uint96-validated TIP-1034 `open` calldata fields. */
export type ParsedOpenCall = {
  authorizedSigner: Address
  deposit: Uint96
  operator: Address
  payee: Address
  salt: Hex
  token: Address
}

/** Validates that calldata contains exactly one TIP-1034 approve-less `open` call. */
export function parseOpenCall(parameters: ParseOpenCallParameters): ParsedOpenCall {
  let decoded: ReturnType<typeof decodeFunctionData<typeof escrowAbi>>
  try {
    decoded = decodeFunctionData({ abi: escrowAbi, data: parameters.data })
  } catch {
    throw new Error('Expected TIP-1034 open calldata.')
  }
  if (decoded.functionName !== 'open') throw new Error('Expected TIP-1034 open calldata.')
  const [payee, operator, token, deposit, salt, authorizedSigner] = decoded.args
  const expected = parameters.expected
  if (expected?.payee && !isAddressEqual(payee, expected.payee))
    throw new Error('TIP-1034 open payee does not match challenge.')
  if (expected?.operator && !isAddressEqual(operator, expected.operator))
    throw new Error('TIP-1034 open operator does not match challenge.')
  if (expected?.token && !isAddressEqual(token, expected.token))
    throw new Error('TIP-1034 open token does not match challenge.')
  if (expected?.authorizedSigner && !isAddressEqual(authorizedSigner, expected.authorizedSigner))
    throw new Error('TIP-1034 open authorizedSigner does not match credential.')
  const validatedDeposit = uint96(deposit)
  if (expected?.deposit !== undefined && validatedDeposit !== expected.deposit)
    throw new Error('TIP-1034 open deposit does not match challenge.')
  return { payee, operator, token, deposit: validatedDeposit, salt, authorizedSigner }
}

/** Optional expected values used to validate a TIP-1034 `topUp` calldata payload. */
export type ParseTopUpCallExpected = {
  additionalDeposit?: Uint96 | undefined
  descriptor?: Channel.ChannelDescriptor | undefined
}

/** Input for parsing and validating TIP-1034 `topUp` calldata. */
export type ParseTopUpCallParameters = {
  data: Hex
  expected?: ParseTopUpCallExpected | undefined
}

/** Decoded and uint96-validated TIP-1034 `topUp` calldata fields. */
export type ParsedTopUpCall = {
  additionalDeposit: Uint96
  descriptor: Channel.ChannelDescriptor
}

type ChannelDescriptorComparison = {
  actual: Channel.ChannelDescriptor
  expected: Channel.ChannelDescriptor
}

function isSameChannelDescriptor(parameters: ChannelDescriptorComparison): boolean {
  const { actual, expected } = parameters
  return (
    isAddressEqual(actual.payer, expected.payer) &&
    isAddressEqual(actual.payee, expected.payee) &&
    isAddressEqual(actual.operator, expected.operator) &&
    isAddressEqual(actual.token, expected.token) &&
    isAddressEqual(actual.authorizedSigner, expected.authorizedSigner) &&
    actual.salt.toLowerCase() === expected.salt.toLowerCase() &&
    actual.expiringNonceHash.toLowerCase() === expected.expiringNonceHash.toLowerCase()
  )
}

/** Validates that calldata contains exactly one TIP-1034 descriptor-based `topUp` call. */
export function parseTopUpCall(parameters: ParseTopUpCallParameters): ParsedTopUpCall {
  let decoded: ReturnType<typeof decodeFunctionData<typeof escrowAbi>>
  try {
    decoded = decodeFunctionData({ abi: escrowAbi, data: parameters.data })
  } catch {
    throw new Error('Expected TIP-1034 topUp calldata.')
  }
  if (decoded.functionName !== 'topUp') throw new Error('Expected TIP-1034 topUp calldata.')
  const [descriptor, additionalDeposit] = decoded.args
  const topUpDescriptor = descriptor as Channel.ChannelDescriptor
  const expected = parameters.expected
  if (expected?.descriptor) {
    if (!isSameChannelDescriptor({ actual: topUpDescriptor, expected: expected.descriptor }))
      throw new Error('TIP-1034 topUp descriptor does not match stored channel.')
  }
  const validatedAdditionalDeposit = uint96(additionalDeposit)
  if (
    expected?.additionalDeposit !== undefined &&
    validatedAdditionalDeposit !== expected.additionalDeposit
  )
    throw new Error('TIP-1034 topUp deposit does not match credential.')
  return {
    descriptor: topUpDescriptor,
    additionalDeposit: validatedAdditionalDeposit,
  }
}

/** Input for deriving a TIP-1034 channel descriptor from an accepted open transaction. */
export type DescriptorFromOpenParameters = {
  chainId: number
  channelId?: Hex | undefined
  escrow?: Address | undefined
  expiringNonceHash: Hex
  open: ParsedOpenCall
  payer: Address
}

/** Builds and validates a descriptor from an accepted open call and event expiring nonce hash. */
export function descriptorFromOpen(
  parameters: DescriptorFromOpenParameters,
): Channel.ChannelDescriptor {
  const descriptor = {
    authorizedSigner: parameters.open.authorizedSigner,
    expiringNonceHash: parameters.expiringNonceHash,
    operator: parameters.open.operator,
    payee: parameters.open.payee,
    payer: parameters.payer,
    salt: parameters.open.salt,
    token: parameters.open.token,
  } satisfies Channel.ChannelDescriptor
  if (parameters.channelId) {
    const computed = Channel.computeId({
      ...descriptor,
      chainId: parameters.chainId,
      escrow: parameters.escrow ?? tip20ChannelEscrow,
    })
    if (computed.toLowerCase() !== parameters.channelId.toLowerCase())
      throw new Error('TIP-1034 ChannelOpened channelId does not match descriptor.')
  }
  return descriptor
}
