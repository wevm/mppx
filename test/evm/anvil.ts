import { execFile as execFile_, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  publicActions,
  type Address,
  type Hex,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { deployContract, waitForTransactionReceipt, writeContract } from 'viem/actions'

const execFile = promisify(execFile_)

const foundryRoot = path.resolve(import.meta.dirname, 'foundry')
const mnemonic = 'test test test test test test test test test test test junk'

export const anvilAccounts = {
  deployer: mnemonicToAccount(mnemonic, { addressIndex: 0 }),
  payer: mnemonicToAccount(mnemonic, { addressIndex: 1 }),
  recipient: mnemonicToAccount(mnemonic, { addressIndex: 2 }),
}

export type AnvilFixture = Awaited<ReturnType<typeof startAnvil>>

export async function startAnvil() {
  await buildContracts()

  const port = await getPort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const process_ = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--mnemonic', mnemonic],
    {
      env: withFoundryPath(),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let stderr = ''
  process_.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  try {
    await waitForRpc(rpcUrl, process_, () => stderr)
  } catch (error) {
    process_.kill()
    throw error
  }

  const chain = defineChain({
    id: 31337,
    name: 'Anvil',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain, transport })
  const deployerClient = createWalletClient({
    account: anvilAccounts.deployer,
    chain,
    transport,
  }).extend(publicActions)
  const payerClient = createWalletClient({
    account: anvilAccounts.payer,
    chain,
    transport,
  }).extend(publicActions)

  const [erc20, eip3009, permit2_] = await Promise.all([
    loadArtifact('MockERC20.sol', 'MockERC20'),
    loadArtifact('MockEIP3009Token.sol', 'MockEIP3009Token'),
    loadArtifact('MockPermit2.sol', 'MockPermit2'),
  ])
  const token = await deploy({
    abi: erc20.abi,
    args: ['Mock USDC', 'USDC', 6],
    bytecode: erc20.bytecode,
    client: deployerClient,
    publicClient,
  })
  const authorizationToken = await deploy({
    abi: eip3009.abi,
    args: ['Mock EIP3009 USDC', 'USDC', 6, '1'],
    bytecode: eip3009.bytecode,
    client: deployerClient,
    publicClient,
  })
  const permit2 = await deploy({
    abi: permit2_.abi,
    args: [],
    bytecode: permit2_.bytecode,
    client: deployerClient,
    publicClient,
  })

  await mint({
    amount: 10_000_000n,
    client: deployerClient,
    publicClient,
    token: { abi: erc20.abi, address: token },
    to: anvilAccounts.payer.address,
  })
  await mint({
    amount: 10_000_000n,
    client: deployerClient,
    publicClient,
    token: { abi: eip3009.abi, address: authorizationToken },
    to: anvilAccounts.payer.address,
  })

  return {
    authorizationToken,
    chain,
    deployer: anvilAccounts.deployer,
    payer: anvilAccounts.payer,
    payerClient,
    permit2,
    publicClient,
    recipient: anvilAccounts.recipient,
    rpcUrl,
    serverClient: deployerClient,
    stop: async () => {
      process_.kill()
      await new Promise((resolve) => process_.once('exit', resolve))
    },
    token,
  }
}

async function buildContracts() {
  await execFile('forge', ['build', '--root', foundryRoot], {
    env: withFoundryPath(),
  })
}

function withFoundryPath() {
  return {
    ...process.env,
    PATH: `${path.join(homedir(), '.foundry/bin')}:${process.env.PATH ?? ''}`,
  }
}

async function loadArtifact(
  source: string,
  contract: string,
): Promise<{ abi: any; bytecode: Hex }> {
  const artifactPath = path.join(foundryRoot, 'out', source, `${contract}.json`)
  const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as {
    abi: any
    bytecode: { object: Hex } | Hex
  }
  const bytecode =
    typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode.object
  return { abi: artifact.abi, bytecode }
}

async function deploy(parameters: {
  abi: any
  args: readonly unknown[]
  bytecode: Hex
  client: any
  publicClient: ReturnType<typeof createPublicClient>
}): Promise<Address> {
  const hash = await deployContract(parameters.client, {
    abi: parameters.abi,
    account: anvilAccounts.deployer,
    args: parameters.args,
    bytecode: parameters.bytecode,
    chain: parameters.client.chain,
  } as never)
  const receipt = await waitForTransactionReceipt(parameters.publicClient, { hash })
  if (!receipt.contractAddress) throw new Error('Deployment did not produce a contract address.')
  return receipt.contractAddress
}

async function mint(parameters: {
  amount: bigint
  client: any
  publicClient: ReturnType<typeof createPublicClient>
  to: Address
  token: { abi: any; address: Address }
}) {
  const hash = await writeContract(parameters.client, {
    abi: parameters.token.abi,
    account: anvilAccounts.deployer,
    address: parameters.token.address,
    args: [parameters.to, parameters.amount],
    chain: parameters.client.chain,
    functionName: 'mint',
  } as never)
  await waitForTransactionReceipt(parameters.publicClient, { hash })
}

async function waitForRpc(rpcUrl: string, process_: ChildProcess, getStderr: () => string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process_.exitCode !== null)
      throw new Error(`anvil exited before RPC became ready: ${getStderr()}`)
    try {
      const response = await fetch(rpcUrl, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const json = (await response.json()) as { result?: string }
      if (json.result === '0x7a69') return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for anvil RPC: ${getStderr()}`)
}

async function getPort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port)
        else reject(new Error('Could not allocate an Anvil port.'))
      })
    })
  })
}
