import { isAddress, type Address } from 'viem'

/** EIP-712 typed data types for proof credentials. */
export const types = {
  Proof: [{ name: 'challengeId', type: 'string' }],
} as const

/** Constructs the EIP-712 domain for a proof credential. */
export function domain(chainId: number) {
  return { name: 'MPP', version: '1', chainId } as const
}

/** Constructs the EIP-712 message for a proof credential. */
export function message(challengeId: string) {
  return { challengeId } as const
}

/** Constructs the expected `did:pkh` source DID for a proof credential. */
export function proofSource(parameters: { address: string; chainId: number }): string {
  return `did:pkh:eip155:${parameters.chainId}:${parameters.address}`
}

/** Parses a proof credential `did:pkh:eip155` source DID. */
export function parseProofSource(source: string): { address: Address; chainId: number } | null {
  const match = /^did:pkh:eip155:(0|[1-9]\d*):([^:]+)$/.exec(source)
  if (!match) return null

  const chainIdText = match[1]!
  const address = match[2]!
  const chainId = Number(chainIdText)
  if (!Number.isSafeInteger(chainId)) return null
  if (!isAddress(address)) return null

  return { address: address as Address, chainId }
}
