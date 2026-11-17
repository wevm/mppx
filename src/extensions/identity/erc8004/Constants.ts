/** ERC-8004 values used by the agent identity provider. */
export const Constants = {
  /** Identity type advertised in a 402's `Identity-Required` header. */
  type: 'erc8004',
  /** Chain the default registry is on: Tempo mainnet. */
  chainId: 4217,
  /** The ERC-8004 Identity Registry, at the same address on every chain that deploys it. */
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  /** Default RPC for Tempo mainnet. */
  rpcUrl: 'https://rpc.tempo.xyz',
  /** Carries the agent's ID: `eip155:<chainId>:<registry>:<agentId>`. */
  idHeader: 'Agent-Id',
  /** Carries `<created>.<nonce>.<signature>`: the agent wallet's signature of the request. */
  signatureHeader: 'Agent-Signature',
  /** How long, in seconds, a request signature stays valid. */
  maxAge: 300,
  /** Allowed clock skew, in seconds. */
  clockTolerance: 60,
} as const
