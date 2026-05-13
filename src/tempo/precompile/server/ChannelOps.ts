import type { Address, Hex } from 'viem'
import { decodeFunctionData, isAddressEqual } from 'viem'

import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import type { Uint96 } from '../Types.js'
import { uint96 } from '../Types.js'

/** Validates that calldata contains exactly one TIP-1034 approve-less `open` call. */
export function parseOpenCall(parameters: {
  data: Hex
  expected?:
    | {
        authorizedSigner?: Address | undefined
        deposit?: Uint96 | undefined
        operator?: Address | undefined
        payee?: Address | undefined
        token?: Address | undefined
      }
    | undefined
}) {
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

/** Validates that calldata contains exactly one TIP-1034 descriptor-based `topUp` call. */
export function parseTopUpCall(parameters: {
  data: Hex
  expected?:
    | {
        descriptor?: Channel.ChannelDescriptor | undefined
        additionalDeposit?: Uint96 | undefined
      }
    | undefined
}) {
  let decoded: ReturnType<typeof decodeFunctionData<typeof escrowAbi>>
  try {
    decoded = decodeFunctionData({ abi: escrowAbi, data: parameters.data })
  } catch {
    throw new Error('Expected TIP-1034 topUp calldata.')
  }
  if (decoded.functionName !== 'topUp') throw new Error('Expected TIP-1034 topUp calldata.')
  const [descriptor, additionalDeposit] = decoded.args
  const expected = parameters.expected
  if (expected?.descriptor) {
    const actual = descriptor as Channel.ChannelDescriptor
    const wanted = expected.descriptor
    if (
      !isAddressEqual(actual.payer, wanted.payer) ||
      !isAddressEqual(actual.payee, wanted.payee) ||
      !isAddressEqual(actual.operator, wanted.operator) ||
      !isAddressEqual(actual.token, wanted.token) ||
      !isAddressEqual(actual.authorizedSigner, wanted.authorizedSigner) ||
      actual.salt.toLowerCase() !== wanted.salt.toLowerCase() ||
      actual.expiringNonceHash.toLowerCase() !== wanted.expiringNonceHash.toLowerCase()
    )
      throw new Error('TIP-1034 topUp descriptor does not match stored channel.')
  }
  const validatedAdditionalDeposit = uint96(additionalDeposit)
  if (
    expected?.additionalDeposit !== undefined &&
    validatedAdditionalDeposit !== expected.additionalDeposit
  )
    throw new Error('TIP-1034 topUp deposit does not match credential.')
  return {
    descriptor: descriptor as Channel.ChannelDescriptor,
    additionalDeposit: validatedAdditionalDeposit,
  }
}

/** Builds and validates a descriptor from an accepted open call and event expiring nonce hash. */
export function descriptorFromOpen(parameters: {
  chainId: number
  escrow?: Address | undefined
  expiringNonceHash: Hex
  payer: Address
  open: ReturnType<typeof parseOpenCall>
  channelId?: Hex | undefined
}): Channel.ChannelDescriptor {
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
    const computed = Channel.computeId(descriptor, {
      chainId: parameters.chainId,
      escrow: parameters.escrow ?? tip20ChannelEscrow,
    })
    if (computed.toLowerCase() !== parameters.channelId.toLowerCase())
      throw new Error('TIP-1034 ChannelOpened channelId does not match descriptor.')
  }
  return descriptor
}
