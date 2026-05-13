import type { Hex } from 'ox'
import { encodeAbiParameters, keccak256, type Account, type Address } from 'viem'
import {
  Transaction,
  type z_TransactionRequestTempo,
  type z_TransactionSerializableTempo,
} from 'viem/tempo'

import { tip20ChannelEscrow } from './Constants.js'

export type ExpiringNonceTransaction = (
  | z_TransactionSerializableTempo
  | z_TransactionRequestTempo
) & {
  feePayer?: Account | true | undefined
}

export type ChannelDescriptor = {
  payer: Address
  payee: Address
  operator: Address
  token: Address
  salt: Hex.Hex
  authorizedSigner: Address
  expiringNonceHash: Hex.Hex
}

/** Computes the TIP-1034 channel ID for a precompile channel descriptor. */
export function computeId(
  descriptor: ChannelDescriptor,
  parameters: { chainId: number; escrow?: Address | undefined },
): Hex.Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        descriptor.payer,
        descriptor.payee,
        descriptor.operator,
        descriptor.token,
        descriptor.salt,
        descriptor.authorizedSigner,
        descriptor.expiringNonceHash,
        parameters.escrow ?? tip20ChannelEscrow,
        BigInt(parameters.chainId),
      ],
    ),
  )
}

/**
 * Computes the TIP-1034 `expiringNonceHash` for a channel-opening Tempo transaction.
 *
 * This delegates to viem's Tempo sender-scoped hash helper, which matches the node's
 * `keccak256(encodeForSigning || sender)` consensus preimage. mppx intentionally does
 * not duplicate Tempo transaction encoding logic here.
 */
export function computeExpiringNonceHash(
  transaction: ExpiringNonceTransaction,
  parameters: { sender: Address },
): Hex.Hex {
  const getChannelOpenContextHash = Transaction.getChannelOpenContextHash as (
    transaction: ExpiringNonceTransaction,
    options: { sender: Address },
  ) => Hex.Hex
  return getChannelOpenContextHash(transaction, parameters)
}
