import { hashTypedData, isAddress, type Address, type Hex } from 'viem'

/** EIP-712 primary type for proof credentials. */
export const primaryType = 'Proof' as const

/**
 * EIP-712 typed-data field definitions for Tempo zero-amount proof credentials.
 *
 * The `account` field cryptographically binds the signature to the payer
 * wallet, so a proof signed for one account cannot be replayed against another
 * — including across an access key that is authorized for multiple accounts.
 */
export const types = {
  Proof: [
    { name: 'account', type: 'address' },
    { name: 'challengeId', type: 'string' },
    { name: 'realm', type: 'string' },
  ],
} as const

/** Constructs the EIP-712 domain for a proof credential. */
export function domain(chainId: number) {
  return { name: 'MPP', version: '3', chainId } as const
}

/**
 * Constructs the EIP-712 message for a proof credential.
 *
 * @param parameters - Proof message parameters.
 * @param parameters.account - Payer wallet address the proof is bound to.
 * @param parameters.challengeId - Challenge `id` being proven.
 * @param parameters.realm - Challenge `realm` being proven.
 */
export function message(parameters: { account: Address; challengeId: string; realm: string }) {
  const { account, challengeId, realm } = parameters
  return { account, challengeId, realm } as const
}

/**
 * Constructs the complete EIP-712 typed-data payload for a proof credential.
 *
 * This is the canonical, wallet-bound proof contract: signing this payload
 * commits the signer to a specific `account`, `challengeId`, and `realm`.
 */
export function typedData(parameters: {
  account: Address
  chainId: number
  challengeId: string
  realm: string
}) {
  const { account, chainId, challengeId, realm } = parameters
  return {
    domain: domain(chainId),
    types,
    primaryType,
    message: message({ account, challengeId, realm }),
  } as const
}

/** Computes the EIP-712 digest (signing payload) for a proof credential. */
export function hash(parameters: {
  account: Address
  chainId: number
  challengeId: string
  realm: string
}): Hex {
  return hashTypedData(typedData(parameters))
}

/** Constructs the expected `did:pkh` source DID for a proof credential. */
export function proofSource(parameters: { address: string; chainId: number }): string {
  return `did:pkh:eip155:${parameters.chainId}:${parameters.address}`
}

/** Parses a `did:pkh:eip155` source DID. */
export function parsePkhSource(source: string): { address: Address; chainId: number } | null {
  const match = /^did:pkh:eip155:(0|[1-9]\d*):([^:]+)$/.exec(source)
  if (!match) return null

  const chainIdText = match[1]!
  const address = match[2]!
  const chainId = Number(chainIdText)
  if (!Number.isSafeInteger(chainId)) return null
  if (!isAddress(address)) return null

  return { address: address as Address, chainId }
}
