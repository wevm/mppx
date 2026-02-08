import { AbiParameters, Hash } from 'ox'
import type * as Hex from 'ox/Hex'

/**
 * Computes a channel ID from its parameters.
 *
 * Mirrors the onchain `computeChannelId` function: `keccak256(abi.encode(payer, payee, token, deposit, salt, authorizedSigner, escrowContract, chainId))`.
 */
export function computeId(parameters: computeId.Parameters): Hex.Hex {
  const encoded = AbiParameters.encode(
    AbiParameters.from([
      'address payer',
      'address payee',
      'address token',
      'uint128 deposit',
      'bytes32 salt',
      'address authorizedSigner',
      'address escrowContract',
      'uint256 chainId',
    ]),
    [
      parameters.payer,
      parameters.payee,
      parameters.token,
      parameters.deposit,
      parameters.salt,
      parameters.authorizedSigner,
      parameters.escrowContract,
      BigInt(parameters.chainId),
    ],
  )
  return Hash.keccak256(encoded)
}

export declare namespace computeId {
  type Parameters = {
    /** Address authorized to sign vouchers on behalf of the payer. */
    authorizedSigner: Hex.Hex
    /** Chain ID of the network the escrow contract is deployed on. */
    chainId: number
    /** Initial deposit amount in the channel. */
    deposit: bigint
    /** Address of the escrow contract. */
    escrowContract: Hex.Hex
    /** Address of the payee (recipient). */
    payee: Hex.Hex
    /** Address of the payer (sender). */
    payer: Hex.Hex
    /** Unique salt to differentiate channels with the same parameters. */
    salt: Hex.Hex
    /** Address of the token used for payment. */
    token: Hex.Hex
  }
}
