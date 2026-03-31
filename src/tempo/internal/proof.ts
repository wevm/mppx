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
  const [did, pkh, namespace, chainIdText, address, ...rest] = source.split(':')

  if (
    did !== 'did' ||
    pkh !== 'pkh' ||
    namespace !== 'eip155' ||
    !chainIdText ||
    !address ||
    rest.length > 0
  ) {
    return null
  }

  if (!/^(0|[1-9]\d*)$/.test(chainIdText)) return null

  const chainId = Number(chainIdText)
  if (!Number.isSafeInteger(chainId)) return null
  if (!isAddress(address)) return null

  return { address, chainId }
}
