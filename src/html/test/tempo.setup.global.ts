import assert from 'node:assert'

import { RpcTransport } from 'ox'
import { Server } from 'prool'
import * as TestContainers from 'prool/testcontainers'
import { createClient, defineChain, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Actions, Addresses } from 'viem/tempo'

export default async function () {
  if (process.env.TEMPO_RPC_URL) return

  const tag = await (async () => {
    if (!process.env.VITE_TEMPO_TAG?.startsWith('http')) return process.env.VITE_TEMPO_TAG
    const transport = RpcTransport.fromHttp(process.env.VITE_TEMPO_TAG)
    const result = (await transport.request({
      method: 'web3_clientVersion',
    })) as string
    const sha = result.match(/tempo\/v[\d.]+-([a-f0-9]+)\//)?.[1]
    return `sha-${sha}`
  })()

  const server = Server.create({
    instance: TestContainers.Instance.tempo({
      blockTime: '200ms',
      mnemonic: 'test test test test test test test test test test test junk',
      image: `ghcr.io/tempoxyz/tempo:${tag ?? 'latest'}`,
    }),
  })

  await server.start()

  const address = server.address()
  assert(address?.port)
  const rpcUrl = `http://localhost:${address.port}/1`
  await fetch(`${rpcUrl}/start`)

  // Mint Fee AMM liquidity so stablecoin fee payments work
  const account = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  )
  const chain = defineChain({
    ...tempoLocalnet,
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const client = createClient({ account, chain, transport: http() })
  for (const id of [1n, 2n, 3n]) {
    await Actions.amm.mintSync(client, {
      account,
      feeToken: Addresses.pathUsd,
      userTokenAddress: id,
      validatorTokenAddress: Addresses.pathUsd,
      validatorTokenAmount: parseUnits('1000', 6),
      to: account.address,
    })
  }

  process.env.TEMPO_CHAIN_ID = String(tempoLocalnet.id)
  process.env.TEMPO_RPC_URL = rpcUrl

  return () => server.stop()
}
