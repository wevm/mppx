import type { Address } from 'viem'

/** An ERC-8004 agent whose wallet signed the request or paid. */
export type Agent = {
  /** The agent's global ID: `eip155:<chainId>:<registry>:<agentId>`. */
  readonly id: string
  /** The agent's token ID in the Identity Registry. */
  readonly agentId: bigint
  /** The agent's wallet, from the registry's `getAgentWallet`, checksummed. */
  readonly wallet: Address
}
