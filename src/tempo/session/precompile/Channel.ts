import { AbiParameters, Hash, Hex as OxHex } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import type { Account, Address, Hex } from 'viem'
import type { z_TransactionRequestTempo, z_TransactionSerializableTempo } from 'viem/tempo'

import { tip20ChannelEscrow } from './Protocol.js'
import type { ChannelDescriptor } from './Protocol.js'

/** Re-export of the TIP-1034 channel descriptor shape. */
export type { ChannelDescriptor } from './Protocol.js'

/** Tempo transaction shape used to derive the TIP-1034 `expiringNonceHash`. */
export type ExpiringNonceTransaction = (
  | z_TransactionSerializableTempo
  | z_TransactionRequestTempo
) & {
  /** Fee-payer metadata may be present on fee-sponsored open transactions. */
  feePayer?: Account | true | undefined
}

/** Computes the TIP-1034 channel ID for a precompile channel descriptor. */
export function computeId(parameters: computeId.Parameters): Hex {
  const encoded = AbiParameters.encode(
    AbiParameters.from([
      'address payer',
      'address payee',
      'address operator',
      'address token',
      'bytes32 salt',
      'address authorizedSigner',
      'bytes32 expiringNonceHash',
      'address escrow',
      'uint256 chainId',
    ]),
    [
      parameters.payer,
      parameters.payee,
      parameters.operator,
      parameters.token,
      parameters.salt,
      parameters.authorizedSigner,
      parameters.expiringNonceHash,
      parameters.escrow ?? tip20ChannelEscrow,
      BigInt(parameters.chainId),
    ],
  )
  return Hash.keccak256(encoded)
}

/** Type helpers for `computeId()`. */
export declare namespace computeId {
  /** Parameters that uniquely identify a TIP-1034 precompile channel. */
  type Parameters = ChannelDescriptor & {
    /** Chain ID included in the channel ID preimage. */
    chainId: number
    /** Escrow contract/precompile address. Defaults to the canonical TIP-1034 address. */
    escrow?: Address | undefined
  }
}

function encodeTempoTransactionForSigning(transaction: ExpiringNonceTransaction) {
  // ox exposes the exact Tempo signing encoder we need, but its public type
  // does not include viem's request-time fee-payer fields. Keep the bridge at
  // the encoder boundary so channel ID derivation stays explicit.
  return TxEnvelopeTempo.encodeForSigning(transaction as never)
}

/** Input for deriving the transaction body used by TIP-1034 channel identity hashing. */
export type ExpiringNonceHashTransactionParameters = {
  /** Deserialized Tempo transaction that opened the channel. */
  transaction: ExpiringNonceTransaction
  /** Whether the transaction will receive a fee-payer co-signature after payer signing. */
  feePayer?: Account | true | undefined
}

/**
 * Returns the sender-signed transaction body used for TIP-1034 `expiringNonceHash`.
 *
 * Fee-payer co-signing happens after payer signing and must not affect the channel ID preimage.
 */
export function transactionForExpiringNonceHash(
  parameters: ExpiringNonceHashTransactionParameters,
): ExpiringNonceTransaction {
  const { feePayer, transaction } = parameters
  if (!feePayer) return transaction
  return { ...transaction, feePayerSignature: null } as ExpiringNonceTransaction
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
): Hex {
  return Hash.keccak256(
    OxHex.concat(encodeTempoTransactionForSigning(transaction), parameters.sender),
  ) as Hex
}
