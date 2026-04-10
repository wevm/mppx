import type { Address } from 'viem'

import * as Proof_internal from './internal/proof.js'

/** Constructs the canonical `did:pkh:eip155` source DID for Tempo proof credentials. */
export function proofSource(parameters: { address: string; chainId: number }): string {
  return Proof_internal.proofSource(parameters)
}

/** Parses a Tempo proof credential source DID into its chain ID and wallet address. */
export function parseProofSource(source: string): { address: Address; chainId: number } | null {
  return Proof_internal.parseProofSource(source)
}
