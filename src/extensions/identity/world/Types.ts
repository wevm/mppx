/**
 * The signed AgentKit payload sent in the `agentkit` header: a CAIP-122 (SIWE) message's fields
 * plus its signature, with the same field names as `@worldcoin/agentkit`.
 */
export type Payload = {
  readonly domain: string
  readonly address: string
  readonly statement?: string | undefined
  readonly uri: string
  readonly version: string
  /** CAIP-2 chain ID of the signing chain, such as `eip155:480`. */
  readonly chainId: string
  readonly type: 'eip191' | 'eip1271'
  readonly nonce: string
  readonly issuedAt: string
  readonly expirationTime?: string | undefined
  readonly notBefore?: string | undefined
  /** On a paid retry, the Challenge `id` the message is bound to. */
  readonly requestId?: string | undefined
  readonly resources?: readonly string[] | undefined
  readonly signature: string
}

/** A verified, human-backed agent. */
export type VerifiedAgent = {
  /** The agent's wallet address. */
  readonly address: string
  /** CAIP-2 chain ID the agent signed for. */
  readonly chainId: string
  /** Anonymous human identifier from AgentBook (a World ID nullifier hash), hex-encoded. */
  readonly humanId: string
}
