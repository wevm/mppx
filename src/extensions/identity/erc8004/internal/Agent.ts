import { getAddress, isAddress, type Address } from 'viem'

/** Formats an agent's global ID: `eip155:<chainId>:<registry>:<agentId>`. */
export function format(agent: { chainId: number; registry: Address; agentId: bigint }) {
  return `eip155:${agent.chainId}:${getAddress(agent.registry)}:${agent.agentId}`
}

/** Parses an agent's global ID, or returns `undefined` when it is malformed. */
export function parse(value: string) {
  const [, chainId, registry, agentId] =
    /^eip155:(\d{1,15}):(0x[0-9a-fA-F]{40}):(\d{1,78})$/.exec(value) ?? []
  if (!chainId || !registry || !agentId || !isAddress(registry, { strict: false })) return undefined
  return { chainId: Number(chainId), registry: getAddress(registry), agentId: BigInt(agentId) }
}

/** The message an agent's wallet signs (EIP-191) for one request attempt. */
export function message(parameters: {
  id: string
  request: Request
  created: number
  nonce: string
}) {
  const url = new URL(parameters.request.url)
  return [
    'mppx:erc8004',
    parameters.id,
    `${parameters.request.method} ${url.origin}${url.pathname}${url.search}`,
    parameters.created,
    parameters.nonce,
  ].join('\n')
}
