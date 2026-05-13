import type { Address, Client, Hex } from 'viem'
import { encodeFunctionData } from 'viem'
import { readContract, sendTransaction } from 'viem/actions'

import type { ChannelDescriptor } from './Channel.js'
import { tip20ChannelEscrow } from './Constants.js'
import { escrowAbi } from './escrow.abi.js'
import type { Uint96 } from './Types.js'
import { uint96 } from './Types.js'

export type ChannelState = {
  settled: Uint96
  deposit: Uint96
  closeRequestedAt: number
}

export type Channel = {
  descriptor: ChannelDescriptor
  state: ChannelState
}

function stateFromTuple(state: {
  settled: bigint
  deposit: bigint
  closeRequestedAt: number
}): ChannelState {
  return {
    settled: uint96(state.settled),
    deposit: uint96(state.deposit),
    closeRequestedAt: state.closeRequestedAt,
  }
}

function descriptorTuple(descriptor: ChannelDescriptor) {
  return {
    payer: descriptor.payer,
    payee: descriptor.payee,
    operator: descriptor.operator,
    token: descriptor.token,
    salt: descriptor.salt,
    authorizedSigner: descriptor.authorizedSigner,
    expiringNonceHash: descriptor.expiringNonceHash,
  } as const
}

/** Encodes a TIP-1034 approve-less `open` call. */
export function encodeOpen(parameters: {
  payee: Address
  operator: Address
  token: Address
  deposit: Uint96
  salt: Hex
  authorizedSigner: Address
}): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [
      parameters.payee,
      parameters.operator,
      parameters.token,
      parameters.deposit,
      parameters.salt,
      parameters.authorizedSigner,
    ],
  })
}

/** Encodes a descriptor-based TIP-1034 `settle` call. */
export function encodeSettle(
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'settle',
    args: [descriptorTuple(descriptor), cumulativeAmount, signature],
  })
}

/** Encodes a descriptor-based TIP-1034 `topUp` call. */
export function encodeTopUp(descriptor: ChannelDescriptor, additionalDeposit: Uint96): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'topUp',
    args: [descriptorTuple(descriptor), additionalDeposit],
  })
}

/** Encodes a descriptor-based TIP-1034 `close` call. */
export function encodeClose(
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  captureAmount: Uint96,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'close',
    args: [descriptorTuple(descriptor), cumulativeAmount, captureAmount, signature],
  })
}

/** Encodes a descriptor-based TIP-1034 `requestClose` call. */
export function encodeRequestClose(descriptor: ChannelDescriptor): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'requestClose',
    args: [descriptorTuple(descriptor)],
  })
}

/** Encodes a descriptor-based TIP-1034 `withdraw` call. */
export function encodeWithdraw(descriptor: ChannelDescriptor): Hex {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'withdraw',
    args: [descriptorTuple(descriptor)],
  })
}

/** Reads immutable descriptor and mutable state for a TIP-1034 channel. */
export async function getChannel(
  client: Client,
  descriptor: ChannelDescriptor,
  escrow: Address = tip20ChannelEscrow,
): Promise<Channel> {
  const channel = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannel',
    args: [descriptorTuple(descriptor)],
  })
  return {
    descriptor: channel.descriptor,
    state: stateFromTuple(channel.state),
  }
}

/** Reads mutable state for a TIP-1034 channel ID. */
export async function getChannelState(
  client: Client,
  channelId: Hex,
  escrow: Address = tip20ChannelEscrow,
): Promise<ChannelState> {
  const state = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannelState',
    args: [channelId],
  })
  return stateFromTuple(state)
}

/** Reads mutable states for TIP-1034 channel IDs in one precompile call. */
export async function getChannelStatesBatch(
  client: Client,
  channelIds: readonly Hex[],
  escrow: Address = tip20ChannelEscrow,
): Promise<ChannelState[]> {
  const states = await readContract(client, {
    address: escrow,
    abi: escrowAbi,
    functionName: 'getChannelStatesBatch',
    args: [channelIds],
  })
  return states.map(stateFromTuple)
}

/** Broadcasts a descriptor-based TIP-1034 settle transaction with the client's account. */
export async function settle(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
): Promise<Hex> {
  return sendTransaction(client, {
    to: escrow,
    data: encodeSettle(descriptor, cumulativeAmount, signature),
  } as never)
}

/** Broadcasts a descriptor-based TIP-1034 close transaction with the client's account. */
export async function close(
  client: Client,
  descriptor: ChannelDescriptor,
  cumulativeAmount: Uint96,
  captureAmount: Uint96,
  signature: Hex,
  escrow: Address = tip20ChannelEscrow,
): Promise<Hex> {
  return sendTransaction(client, {
    to: escrow,
    data: encodeClose(descriptor, cumulativeAmount, captureAmount, signature),
  } as never)
}
