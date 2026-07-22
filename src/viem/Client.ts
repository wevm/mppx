import { type Chain, type Client, createClient, createTransport, custom, http } from 'viem'
import { withFeePayer } from 'viem/tempo'

import type { MaybePromise } from '../internal/types.js'

export function getResolver(
  parameters: getResolver.Parameters & {
    /** Default chain to use if not provided. */
    chain?: Chain | undefined
    /** Fee payer relay URL. When set, the transport is wrapped with `withFeePayer`. */
    feePayerUrl?: string | undefined
    /** RPC URLs keyed by chain ID. */
    rpcUrl?: ({ [chainId: number]: string } & object) | undefined
  },
): (parameters: { chainId?: number | undefined }) => MaybePromise<Client> {
  const { chain, feePayerUrl, getClient, rpcUrl } = parameters

  if (getClient) {
    // When a default chain with serializers is provided (e.g. Tempo chain config),
    // ensure user-provided clients inherit those serializers. Without this, clients
    // created without the Tempo chain config will use the default viem serializer,
    // causing errors like "maxFeePerGas is not a valid Legacy Transaction attribute".
    if (!chain?.serializers && !feePayerUrl) return getClient
    return async (params) => {
      const client = await getClient(params)
      let resolvedClient = client

      // Wrap the client's transport with `withFeePayer` when a fee payer URL is provided.
      if (feePayerUrl && client.transport.key !== 'feePayer') {
        const request = client.request.bind(client)
        // The supplied client already owns retries. Keep the relay middleware retry-free so
        // failures are not retried once per nested transport layer.
        const feePayerTransport = withFeePayer(
          custom({ request: (args) => request(args as never) }, { retryCount: 0 }),
          http(feePayerUrl, { retryCount: client.transport.retryCount }),
        )({
          account: client.account,
          chain: client.chain,
          pollingInterval: client.pollingInterval,
          retryCount: 0,
        })
        const wrapped = createTransport(
          { ...feePayerTransport.config, retryCount: 0 },
          feePayerTransport.value,
        )
        resolvedClient = Object.assign({}, client, {
          request: wrapped.request,
          transport: { ...wrapped.config, ...wrapped.value },
        })
      }

      if (!chain?.serializers || resolvedClient.chain?.serializers?.transaction)
        return resolvedClient
      return Object.assign({}, resolvedClient, {
        chain: {
          ...chain,
          ...resolvedClient.chain,
          formatters: resolvedClient.chain?.formatters ?? chain.formatters,
          prepareTransactionRequest:
            resolvedClient.chain?.prepareTransactionRequest ?? chain.prepareTransactionRequest,
          serializers: resolvedClient.chain?.serializers?.transaction
            ? resolvedClient.chain.serializers
            : chain.serializers,
        } as typeof resolvedClient.chain,
      })
    }
  }

  return ({ chainId }: { chainId?: number | undefined }) => {
    if (!rpcUrl) throw new Error('No `rpcUrl` provided.')
    const resolvedChainId = chainId || Number(Object.keys(rpcUrl)[0])!
    const url = rpcUrl[resolvedChainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${resolvedChainId}).`)
    const transport = feePayerUrl ? withFeePayer(http(url), http(feePayerUrl)) : http(url)
    return createClient({
      chain: { ...chain, id: resolvedChainId } as never,
      transport,
    })
  }
}

export declare namespace getResolver {
  type Parameters = {
    /** Function that returns a client for the given chain ID. */
    getClient?: ((parameters: { chainId?: number | undefined }) => MaybePromise<Client>) | undefined
  }
}
