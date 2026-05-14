import { AbiParameters, Hash } from "ox";
import type { Account, Address, Hex } from "viem";
import {
  Transaction,
  type z_TransactionRequestTempo,
  type z_TransactionSerializableTempo,
} from "viem/tempo";

import { tip20ChannelEscrow } from "./Constants.js";
import type { ChannelDescriptor } from "./Types.js";

export type { ChannelDescriptor } from "./Types.js";

export type ExpiringNonceTransaction = (
  | z_TransactionSerializableTempo
  | z_TransactionRequestTempo
) & {
  feePayer?: Account | true | undefined;
};

/** Computes the TIP-1034 channel ID for a precompile channel descriptor. */
export function computeId(parameters: computeId.Parameters): Hex {
  const encoded = AbiParameters.encode(
    AbiParameters.from([
      "address payer",
      "address payee",
      "address operator",
      "address token",
      "bytes32 salt",
      "address authorizedSigner",
      "bytes32 expiringNonceHash",
      "address escrow",
      "uint256 chainId",
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
  );
  return Hash.keccak256(encoded);
}

export declare namespace computeId {
  type Parameters = ChannelDescriptor & {
    chainId: number;
    escrow?: Address | undefined;
  };
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
  const getChannelOpenContextHash = Transaction.getChannelOpenContextHash as (
    transaction: ExpiringNonceTransaction,
    options: { sender: Address },
  ) => Hex;
  return getChannelOpenContextHash(transaction, parameters);
}
