import { AbiParameters, Hash, Hex } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import type { Account, Address, Hex as viem_Hex } from 'viem'
import { type z_TransactionRequestTempo, type z_TransactionSerializableTempo } from 'viem/tempo'

import { tip20ChannelEscrow } from './Constants.js'
import type { ChannelDescriptor } from './Types.js'

export type { ChannelDescriptor } from './Types.js'

export type ExpiringNonceTransaction = (
  | z_TransactionSerializableTempo
  | z_TransactionRequestTempo
) & {
  feePayer?: Account | true | undefined
}

/** Computes the TIP-1034 channel ID for a precompile channel descriptor. */
export function computeId(parameters: computeId.Parameters): viem_Hex {
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

export declare namespace computeId {
  type Parameters = ChannelDescriptor & {
    chainId: number
    escrow?: Address | undefined
  }
}

/**
 * Computes the TIP-1034 `expiringNonceHash` for a channel-opening Tempo transaction.
 *
 * This uses the same Tempo transaction signing payload that the node uses for the
 * enclosing transaction context: `keccak256(abi.encodePacked(encodeForSigning, sender))`.
 */
export function computeExpiringNonceHash(
  transaction: ExpiringNonceTransaction,
  parameters: { sender: Address },
): viem_Hex {
  const transaction_ = transaction as ExpiringNonceTransaction & {
    feePayerSignature?: unknown
  }
  const envelope = TxEnvelopeTempo.from({
    ...transaction_,
    feeToken:
      transaction_.feePayer === true && !transaction_.feePayerSignature
        ? undefined
        : transaction_.feeToken,
    type: 'tempo',
  } as TxEnvelopeTempo.Input)
  return Hash.keccak256(Hex.concat(TxEnvelopeTempo.encodeForSigning(envelope), parameters.sender))
}
