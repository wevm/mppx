import { type Chain, type Client, createClient, http } from 'viem'

export function getResolver(
  parameters: getResolver.Parameters & {
    /** Default chain to use if not provided. */
    chain?: Chain | undefined
    /** RPC URLs keyed by chain ID. */
    rpcUrl?: ({ [chainId: number]: string } & object) | undefined
  },
): (chainId: number) => Client {
  const { chain, client, rpcUrl } = parameters

  if (client) return client

  return (chainId: number) => {
    if (!rpcUrl) throw new Error('No `rpcUrl` provided.')
    const resolvedChainId = chainId || Number(Object.keys(rpcUrl)[0])!
    const url = rpcUrl[resolvedChainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${resolvedChainId}).`)
    return createClient({
      chain: { ...chain, id: resolvedChainId } as never,
      transport: http(url),
    })
  }
}

export declare namespace getResolver {
  type Parameters = {
    /** Function that returns a client for the given chain ID. */
    client?: ((chainId: number) => Client) | undefined
  }
}
