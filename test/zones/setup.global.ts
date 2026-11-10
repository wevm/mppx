import { execFileSync } from 'node:child_process'

import { createClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { waitForTransactionReceipt, writeContract } from 'viem/actions'
import { tempoLocalnet } from 'viem/chains'

import * as Zone from '../../src/tempo/internal/zone.js'

/**
 * Starts a Tempo dev node and a dev Zone (`tempo-zone dev`) in Docker for the
 * `zones` test project, unless `VITE_ZONE_L1_RPC_URL` and `VITE_ZONE_RPC_URL`
 * point at running ones.
 */

/** The dev mnemonic's first account: Tempo's faucet and the dev Zone's admin. */
const devKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const token = '0x20c0000000000000000000000000000000000000'
const tag = process.env.VITE_TEMPO_TAG || 'latest'
const l1HttpPort = Number(process.env.VITE_ZONE_L1_HTTP_PORT ?? 18645)
const l1WsPort = Number(process.env.VITE_ZONE_L1_WS_PORT ?? 18646)
const zonePort = Number(process.env.VITE_ZONE_PORT ?? 18647)
const containers = ['mppx-zones-l1', 'mppx-zones-zone']
const network = 'mppx-zones'

/** Connection details the setup passes to the tests. */
export type Context = {
  l1RpcUrl: string
  token: `0x${string}`
  zoneChainId: number
  zoneId: number
  zoneRpcUrl: string
}

/** Passes the context to test workers, which inherit the environment. */
function provide(context: Context) {
  process.env.MPPX_ZONES_CONTEXT = JSON.stringify(context)
}

function docker(...args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function rpc(url: string, method: string, params: unknown[] = []) {
  const response = await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result
}

async function waitFor(url: string, label: string, container?: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (container && docker('inspect', '-f', '{{.State.Running}}', container).trim() !== 'true')
      throw new Error(`${label} container ${container} exited.`)
    try {
      return Number(await rpc(url, 'eth_chainId'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`${label} did not answer at ${url} within ${timeoutMs}ms.`)
}

export default async function setup() {
  if (process.env.VITE_ZONE_L1_RPC_URL && process.env.VITE_ZONE_RPC_URL) {
    const zoneChainId = await waitFor(process.env.VITE_ZONE_RPC_URL, 'Zone')
    provide({
      l1RpcUrl: process.env.VITE_ZONE_L1_RPC_URL,
      token,
      zoneChainId,
      zoneId: Zone.idFromChainId(zoneChainId),
      zoneRpcUrl: process.env.VITE_ZONE_RPC_URL,
    })
    return
  }

  const cleanup = () => {
    for (const name of containers)
      try {
        docker('rm', '-f', name)
      } catch {}
    try {
      docker('network', 'rm', network)
    } catch {}
  }
  const teardown = () => {
    if (process.env.VITE_ZONE_KEEP !== 'true') cleanup()
  }
  cleanup()
  docker('network', 'create', network)

  docker(
    'run',
    '-d',
    '--name',
    'mppx-zones-l1',
    '--network',
    network,
    '-p',
    `127.0.0.1:${l1HttpPort}:8545`,
    '-p',
    `127.0.0.1:${l1WsPort}:8546`,
    `ghcr.io/tempoxyz/tempo:${tag}`,
    'node',
    '--dev',
    '--dev.block-time',
    '500ms',
    '--dev.mnemonic',
    'test test test test test test test test test test test junk',
    '--datadir',
    '/tmp/mppx-zones-l1',
    '--faucet.address',
    token,
    '--faucet.amount',
    '1000000000000',
    '--faucet.enabled',
    '--faucet.private-key',
    devKey,
    '--http',
    '--http.addr',
    '0.0.0.0',
    '--http.port',
    '8545',
    '--http.api',
    'all',
    '--ws',
    '--ws.addr',
    '0.0.0.0',
    '--ws.port',
    '8546',
    '--ws.api',
    'all',
    '--ws.origins',
    '*',
    '--port',
    '54525',
    '--authrpc.port',
    '54545',
  )
  const l1RpcUrl = `http://127.0.0.1:${l1HttpPort}`
  try {
    await waitFor(l1RpcUrl, 'Tempo', 'mppx-zones-l1')

    // ZoneFactory only accepts a token whose transfer policy is set in the TIP-403 registry.
    const l1 = createClient({
      account: privateKeyToAccount(devKey),
      chain: { ...tempoLocalnet, rpcUrls: { default: { http: [l1RpcUrl] } } },
      transport: http(l1RpcUrl),
    })
    const hash = await writeContract(l1, {
      abi: parseAbi(['function changeTransferPolicyId(uint64)']),
      address: token,
      args: [1n],
      functionName: 'changeTransferPolicyId',
    } as never)
    await waitForTransactionReceipt(l1, { hash })

    docker(
      'run',
      '-d',
      '--name',
      'mppx-zones-zone',
      '--network',
      network,
      '-p',
      `127.0.0.1:${zonePort}:9545`,
      `ghcr.io/tempoxyz/tempo-zone:${tag}`,
      'dev',
      '--l1.rpc-url',
      'ws://mppx-zones-l1:8546',
      '--http.addr',
      '0.0.0.0',
      '--http.port',
      '9545',
    )
    const zoneRpcUrl = `http://127.0.0.1:${zonePort}`
    const zoneChainId = await waitFor(zoneRpcUrl, 'Zone', 'mppx-zones-zone')
    provide({
      l1RpcUrl,
      token,
      zoneChainId,
      zoneId: Zone.idFromChainId(zoneChainId),
      zoneRpcUrl,
    })
  } catch (error) {
    for (const name of containers)
      try {
        console.error(docker('logs', '--tail', '50', name))
      } catch {}
    teardown()
    throw error
  }
  return teardown
}
