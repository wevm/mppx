import type { Address, Hex } from 'viem'

import * as Proof_internal from './internal/proof.js'

/** EIP-712 primary type for Tempo proof credentials. */
export const primaryType = Proof_internal.primaryType

/**
 * EIP-712 typed-data field definitions for Tempo zero-amount proof credentials.
 *
 * The `account` field cryptographically binds the signature to the payer
 * wallet, so a proof signed for one account cannot be replayed against another.
 */
export const types = Proof_internal.types

/** Constructs the EIP-712 domain for a Tempo proof credential. */
export function domain(chainId: number) {
  return Proof_internal.domain(chainId)
}

/**
 * Constructs the EIP-712 message for a Tempo proof credential.
 *
 * @param parameters - Proof message parameters.
 * @param parameters.account - Payer wallet address the proof is bound to.
 * @param parameters.challengeId - Challenge `id` being proven.
 * @param parameters.realm - Challenge `realm` being proven.
 */
export function message(parameters: { account: Address; challengeId: string; realm: string }) {
  return Proof_internal.message(parameters)
}

/**
 * Constructs the complete EIP-712 typed-data payload for a Tempo proof
 * credential — the canonical, wallet-bound proof contract.
 */
export function typedData(parameters: {
  account: Address
  chainId: number
  challengeId: string
  realm: string
}) {
  return Proof_internal.typedData(parameters)
}

/** Computes the EIP-712 digest (signing payload) for a Tempo proof credential. */
export function hash(parameters: {
  account: Address
  chainId: number
  challengeId: string
  realm: string
}): Hex {
  return Proof_internal.hash(parameters)
}

/** Constructs the canonical `did:pkh:eip155` source DID for Tempo proof credentials. */
export function proofSource(parameters: { address: string; chainId: number }): string {
  return Proof_internal.proofSource(parameters)
}

/** Parses a Tempo `did:pkh:eip155` source DID into its chain ID and wallet address. */
export function parsePkhSource(source: string): { address: Address; chainId: number } | null {
  return Proof_internal.parsePkhSource(source)
}

/** Parses a Tempo proof credential source DID into its chain ID and wallet address. */
export function parseProofSource(source: string): { address: Address; chainId: number } | null {
  return Proof_internal.parsePkhSource(source)
}
