/** World AgentKit values, matching `@worldcoin/agentkit` so x402 registrations work on MPP. */
export const Constants = {
  /** Request header carrying the signed AgentKit payload, base64-encoded JSON. Same as x402. */
  header: 'agentkit',
  /** Canonical AgentBook deployment on World Chain. */
  agentBook: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA',
  /** World Chain ID, where AgentBook lookups resolve. */
  worldChainId: 480,
  /** Default World Chain RPC URL. */
  rpcUrl: 'https://worldchain-mainnet.g.alchemy.com/public',
  /** Default maximum age, in seconds, of a signed AgentKit message. */
  maxAge: 5 * 60,
  /** Allowed clock skew, in seconds, for a message issued in the future. */
  clockSkew: 30,
  /** Statement signed when the client sets none. */
  statement: 'Verify your agent is backed by a real human',
  /** Where an unregistered agent registers its wallet. */
  registration: 'https://docs.world.org/agents/agent-kit',
} as const
