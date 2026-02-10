import { type Chain, type Client, createClient, http } from 'viem'
import type { MaybePromise } from '../internal/types.js'

export function getResolver(
  parameters: getResolver.Parameters & {
    /** Default chain to use if not provided. */
    chain?: Chain | undefined
    /** RPC URLs keyed by chain ID. */
    rpcUrl?: ({ [chainId: number]: string } & object) | undefined
  },
): (parameters: { chainId?: number | undefined }) => MaybePromise<Client> {
  const { chain, getClient, rpcUrl } = parameters

  if (getClient) return getClient

  return ({ chainId }: { chainId?: number | undefined }) => {
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
    getClient?: ((parameters: { chainId?: number | undefined }) => MaybePromise<Client>) | undefined
  }
}
