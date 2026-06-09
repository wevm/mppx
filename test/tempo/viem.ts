import type * as Hex from 'ox/Hex'
import {
  createClient,
  defineChain,
  type Chain as viem_Chain,
  type HttpTransportConfig,
  http as viem_http,
} from 'viem'
import { type LocalAccount, mnemonicToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'

import { tempoNetworkConfig, tempoRpcUrl as rpcUrl } from '../config.js'

export const asset = '0x20c0000000000000000000000000000000000001' as const

const localnetTransportOptions = tempoNetworkConfig.isLocalnet
  ? {
      retryCount: 0,
      timeout: 30_000,
    }
  : undefined

const accountsMnemonic = 'test test test test test test test test test test test junk'

export const accounts = Array.from({ length: 20 }, (_, i) =>
  mnemonicToAccount(accountsMnemonic, {
    accountIndex: i,
  }),
) as unknown as FixedArray<LocalAccount, 20>

function withRpcUrl<const chain extends viem_Chain>(chain: chain): chain {
  if (!import.meta.env.VITE_RPC_URL) return chain
  return defineChain({
    ...chain,
    rpcUrls: {
      ...chain.rpcUrls,
      default: {
        ...chain.rpcUrls.default,
        http: [rpcUrl],
      },
    },
  }) as unknown as chain
}

export const chain = (() => {
  if (tempoNetworkConfig.isDevnet) return withRpcUrl(tempoNetworkConfig.chain)
  return defineChain({
    ...tempoNetworkConfig.chain,
    rpcUrls: { default: { http: [rpcUrl] } },
  })
})() as typeof tempoNetworkConfig.chain

export function debugOptions({ rpcUrl }: { rpcUrl: string }): HttpTransportConfig | undefined {
  if (import.meta.env.VITE_HTTP_LOG !== 'true') return undefined
  return {
    async onFetchRequest(_, init) {
      console.log(`curl \\
${rpcUrl} \\
-X POST \\
-H "Content-Type: application/json" \\
-d '${JSON.stringify(JSON.parse(init.body as string))}'`)
    },
    async onFetchResponse(response) {
      console.log(`> ${JSON.stringify(await response.clone().json())}`)
    },
  }
}

export const http = (url = rpcUrl) =>
  viem_http(url, {
    ...debugOptions({
      rpcUrl: url,
    }),
    ...localnetTransportOptions,
    ...(import.meta.env.VITE_RPC_CREDENTIALS
      ? {
          fetchOptions: {
            headers: {
              Authorization: `Basic ${btoa(import.meta.env.VITE_RPC_CREDENTIALS)}`,
            },
          },
        }
      : {}),
  })

export const client = createClient({
  account: accounts[0],
  chain,
  transport: http(rpcUrl),
}) as import('viem').Client<import('viem').HttpTransport, typeof chain, (typeof accounts)[0]>

export async function fundAccount(parameters: { address: Hex.Hex; token: Hex.Hex }) {
  const { address, token } = parameters
  await Actions.token.transferSync(client, {
    account: accounts[0],
    chain,
    token,
    to: address,
    amount: 10000000000n,
  })
}

type FixedArray<
  type,
  count extends number,
  result extends readonly type[] = [],
> = result['length'] extends count ? result : FixedArray<type, count, readonly [...result, type]>
