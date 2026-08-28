import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'

import { x402Client, x402HTTPClient } from '@x402/core/client'
import { x402Facilitator } from '@x402/core/facilitator'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { toFacilitatorEvmSigner } from '@x402/evm'
import { ExactEvmScheme as ExactEvmClient } from '@x402/evm/exact/client'
import { ExactEvmScheme as ExactEvmFacilitator } from '@x402/evm/exact/facilitator'
import { ExactEvmScheme as ExactEvmServer } from '@x402/evm/exact/server'
import { paymentMiddleware } from '@x402/express'
import express from 'express'
import { evm as evmClient, Mppx as ClientMppx } from 'mppx/client'
import { Proxy } from 'mppx/proxy'
import { evm as evmServer, Mppx as ServerMppx } from 'mppx/server'
import type { Abi, Address, Hex } from 'viem'
import {
  createClient,
  createWalletClient,
  defineChain,
  getAddress,
  http as viem_http,
  parseUnits,
  publicActions,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import {
  deployContract,
  readContract,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'
import { describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'

import cli from '../cli/cli.js'
import * as Header from './Header.js'
import * as ChallengeBrand from './internal/ChallengeBrand.js'
import * as Types from './Types.js'

const runLocalnet = process.env.X402_LOCALNET === 'true'
const describeLocalnet = runLocalnet ? describe : describe.skip

const chainId = 31_337
const network = `eip155:${chainId}` as const
const rpcUrl = process.env.X402_ANVIL_RPC_URL ?? 'http://127.0.0.1:18546'
const mnemonic = 'test test test test test test test test test test test junk'
const payerPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const payer = mnemonicToAccount(mnemonic, { accountIndex: 0 })
const recipient = mnemonicToAccount(mnemonic, { addressIndex: 1 })
const facilitatorAccount = mnemonicToAccount(mnemonic, { addressIndex: 2 })
const paymentAmount = parseUnits('0.01', 6)

const chain = defineChain({
  id: chainId,
  name: 'Anvil',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: { default: { http: [rpcUrl] } },
})

const transport = viem_http(rpcUrl, { retryCount: 0, timeout: 10_000 })
const payerClient = createClient({ account: payer, chain, transport })

type ForgeArtifact = {
  abi: Abi
  bytecode: { object: Hex }
}

type CoinbaseFacilitatorServer = Http.TestServer & {
  stats: {
    settleRequests: number
    supportedRequests: number
    verifyRequests: number
  }
}

type CoinbaseHarness = {
  artifact: ForgeArtifact
  facilitator: CoinbaseFacilitatorServer
  resourceServer: Http.TestServer
  token: Address
}

describeLocalnet('Coinbase x402 client interoperability', () => {
  test(
    'pays an automatically scoped mppx proxy with the Coinbase client',
    { timeout: 60_000 },
    async () => {
      const harness = await setupCoinbaseHarness()

      try {
        const proxy = createMppxProxy(harness)
        const url = 'https://example.com/proxy/coinbase/paid'
        const challenge = await proxy.fetch(new Request(url))
        expect(challenge.status).toBe(402)

        const client = new x402Client().register(network, new ExactEvmClient(payer))
        const httpClient = new x402HTTPClient(client)
        const paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
          challenge.headers.get(name),
        )
        const paymentPayload = await httpClient.createPaymentPayload(paymentRequired)
        const headers = httpClient.encodePaymentSignatureHeader(paymentPayload)
        const credential = new Headers(headers).get(Types.paymentSignatureHeader)
        expect(credential).toBeTruthy()

        const decodedPayload = Header.decodePaymentSignature(credential!)
        expect(decodedPayload.extensions).toEqual(paymentRequired.extensions)
        expect(decodedPayload.extensions?.mppx?.info).toMatchObject({
          _mppx_scope: 'GET /proxy/coinbase/paid',
          method: 'GET',
        })
        expect(decodedPayload.extensions?.mppx?.info.nonce).toBeUndefined()
        if (!('authorization' in decodedPayload.payload)) throw new Error()
        expect(decodedPayload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)

        const payerBefore = await balanceOf(harness.artifact, harness.token, payer.address)
        const recipientBefore = await balanceOf(harness.artifact, harness.token, recipient.address)
        const response = await proxy.fetch(new Request(url, { headers }))

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('paid by Coinbase')
        const paymentResponseHeader = response.headers.get(Types.paymentResponseHeader)
        expect(paymentResponseHeader).toBeTruthy()
        const paymentResponse = Header.decodePaymentResponse(paymentResponseHeader!)
        const receipt = await waitForTransactionReceipt(payerClient, {
          hash: paymentResponse.transaction as Hex,
        })
        expect(receipt.status).toBe('success')
        expect(await balanceOf(harness.artifact, harness.token, payer.address)).toBe(
          payerBefore - paymentAmount,
        )
        expect(await balanceOf(harness.artifact, harness.token, recipient.address)).toBe(
          recipientBefore + paymentAmount,
        )
        expect(harness.facilitator.stats).toEqual({
          settleRequests: 1,
          supportedRequests: 1,
          verifyRequests: 1,
        })
      } finally {
        closeCoinbaseHarness(harness)
      }
    },
  )

  test('pays a Coinbase resource server with the mppx client', { timeout: 60_000 }, async () => {
    const harness = await setupCoinbaseHarness()

    try {
      const challenge = await fetch(`${harness.resourceServer.url}/paid`)
      expect(challenge.status).toBe(402)

      const paymentRequiredHeader = challenge.headers.get(Types.paymentRequiredHeader)
      expect(paymentRequiredHeader).toBeTruthy()
      const paymentRequired = Header.decodePaymentRequired(paymentRequiredHeader!)
      expect(paymentRequired).toMatchObject({
        accepts: [
          {
            amount: paymentAmount.toString(),
            asset: harness.token.toLowerCase(),
            network,
            payTo: recipient.address,
            scheme: 'exact',
          },
        ],
        x402Version: 2,
      })
      expect(paymentRequired.extensions?.mppx).toBeUndefined()
      expect(paymentRequired.resource.url).toBe(`${harness.resourceServer.url}/paid`)
      expect(harness.facilitator.stats).toEqual({
        settleRequests: 0,
        supportedRequests: 1,
        verifyRequests: 0,
      })

      const payerBefore = await balanceOf(harness.artifact, harness.token, payer.address)
      const recipientBefore = await balanceOf(harness.artifact, harness.token, recipient.address)
      const response = await createMppxClient(harness.token).fetch(
        `${harness.resourceServer.url}/paid`,
      )

      if (response.status !== 200)
        throw new Error(`Expected paid response, got ${response.status}: ${await response.text()}`)
      expect(await response.text()).toBe('paid by mppx')

      const paymentResponseHeader = response.headers.get(Types.paymentResponseHeader)
      expect(paymentResponseHeader).toBeTruthy()
      const paymentResponse = Header.decodePaymentResponse(paymentResponseHeader!)
      expect(paymentResponse).toMatchObject({
        network,
        payer: getAddress(payer.address),
        success: true,
      })

      const receipt = await waitForTransactionReceipt(payerClient, {
        hash: paymentResponse.transaction as Hex,
      })
      expect(receipt.status).toBe('success')
      expect(await balanceOf(harness.artifact, harness.token, payer.address)).toBe(
        payerBefore - paymentAmount,
      )
      expect(await balanceOf(harness.artifact, harness.token, recipient.address)).toBe(
        recipientBefore + paymentAmount,
      )
      expect(harness.facilitator.stats).toEqual({
        settleRequests: 1,
        supportedRequests: 1,
        verifyRequests: 1,
      })
    } finally {
      closeCoinbaseHarness(harness)
    }
  })

  test('pays a live Coinbase resource server with the CLI', { timeout: 60_000 }, async () => {
    const harness = await setupCoinbaseHarness()

    try {
      const payerBefore = await balanceOf(harness.artifact, harness.token, payer.address)
      const recipientBefore = await balanceOf(harness.artifact, harness.token, recipient.address)
      const result = await runCli(
        [
          `${harness.resourceServer.url}/paid`,
          '--protocol',
          'x402',
          '--currency',
          harness.token.toUpperCase(),
          '--silent',
        ],
        { MPPX_PRIVATE_KEY: payerPrivateKey },
      )

      expect(result.exitCode).toBeUndefined()
      expect(result.output).toContain('paid by mppx')
      expect(await balanceOf(harness.artifact, harness.token, payer.address)).toBe(
        payerBefore - paymentAmount,
      )
      expect(await balanceOf(harness.artifact, harness.token, recipient.address)).toBe(
        recipientBefore + paymentAmount,
      )
      expect(harness.facilitator.stats).toEqual({
        settleRequests: 1,
        supportedRequests: 1,
        verifyRequests: 1,
      })
    } finally {
      closeCoinbaseHarness(harness)
    }
  })

  test('rejects a replayed mppx credential', { timeout: 60_000 }, async () => {
    const harness = await setupCoinbaseHarness()

    try {
      const mppx = createMppxClient(harness.token)
      const challenge = await mppx.rawFetch(`${harness.resourceServer.url}/paid`)
      const credential = await mppx.createCredential(challenge)
      const paymentPayload = Header.decodePaymentSignature(credential)

      expect(paymentPayload.extensions?.mppx).toBeUndefined()
      expect(paymentPayload.resource?.url).toBe(`${harness.resourceServer.url}/paid`)
      if (!('authorization' in paymentPayload.payload)) throw new Error()
      expect(paymentPayload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/)

      const payerBefore = await balanceOf(harness.artifact, harness.token, payer.address)
      const recipientBefore = await balanceOf(harness.artifact, harness.token, recipient.address)
      const headers = { [Types.paymentSignatureHeader]: credential }

      const first = await mppx.rawFetch(`${harness.resourceServer.url}/paid`, { headers })
      expect(first.status).toBe(200)
      expect(await first.text()).toBe('paid by mppx')
      const paymentResponseHeader = first.headers.get(Types.paymentResponseHeader)
      expect(paymentResponseHeader).toBeTruthy()
      const paymentResponse = Header.decodePaymentResponse(paymentResponseHeader!)
      expect(paymentResponse.success).toBe(true)
      const receipt = await waitForTransactionReceipt(payerClient, {
        hash: paymentResponse.transaction as Hex,
      })
      expect(receipt.status).toBe('success')

      const replay = await mppx.rawFetch(`${harness.resourceServer.url}/paid`, { headers })
      expect(replay.status).toBe(402)
      const replayHeader = replay.headers.get(Types.paymentRequiredHeader)
      expect(replayHeader).toBeTruthy()
      expect(Header.decodePaymentRequired(replayHeader!).error).toBeTruthy()
      expect(await balanceOf(harness.artifact, harness.token, payer.address)).toBe(
        payerBefore - paymentAmount,
      )
      expect(await balanceOf(harness.artifact, harness.token, recipient.address)).toBe(
        recipientBefore + paymentAmount,
      )
      expect(harness.facilitator.stats).toEqual({
        settleRequests: 1,
        supportedRequests: 1,
        verifyRequests: 2,
      })
    } finally {
      closeCoinbaseHarness(harness)
    }
  })
})

async function setupCoinbaseHarness(): Promise<CoinbaseHarness> {
  const artifact = await loadArtifact()
  const token = await deployToken(artifact)
  await mint(artifact, token, payer.address, parseUnits('1000', 6))
  const facilitator = await createCoinbaseFacilitator()

  try {
    return {
      artifact,
      facilitator,
      resourceServer: await createCoinbaseResourceServer({
        facilitatorUrl: facilitator.url,
        token,
      }),
      token,
    }
  } catch (error) {
    facilitator.close()
    throw error
  }
}

function closeCoinbaseHarness(harness: CoinbaseHarness): void {
  harness.resourceServer.close()
  harness.facilitator.close()
}

/** Runs the CLI in-process while isolating its account environment and stdout. */
async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number | undefined; output: string }> {
  const output: Buffer[] = []
  const previousEnv: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const originalStdoutWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown) => {
    output.push(Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk)))
    return true
  }) as typeof process.stdout.write

  let exitCode: number | undefined
  try {
    await cli.serve(argv, {
      exit(code: number) {
        exitCode = code
      },
      stdout(value: string) {
        output.push(Buffer.from(value))
      },
    })
  } finally {
    process.stdout.write = originalStdoutWrite
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  return { exitCode, output: Buffer.concat(output).toString() }
}

async function createCoinbaseFacilitator(): Promise<CoinbaseFacilitatorServer> {
  const viemClient = createWalletClient({
    account: facilitatorAccount,
    chain,
    transport,
  }).extend(publicActions)
  const signer = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    getCode: (args) => viemClient.getCode(args),
    readContract: (args) => viemClient.readContract(args as never),
    sendTransaction: (args) => viemClient.sendTransaction(args as never),
    verifyTypedData: (args) => viemClient.verifyTypedData(args as never),
    waitForTransactionReceipt: (args) => viemClient.waitForTransactionReceipt(args),
    writeContract: (args) => viemClient.writeContract(args as never),
  })
  const facilitator = new x402Facilitator().register(network, new ExactEvmFacilitator(signer))
  const stats = { settleRequests: 0, supportedRequests: 0, verifyRequests: 0 }

  const server = await Http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/supported') {
      stats.supportedRequests++
      return sendJson(res, facilitator.getSupported())
    }

    if (req.method === 'POST' && req.url === '/verify') {
      stats.verifyRequests++
      const { paymentPayload, paymentRequirements } = await readFacilitatorRequest(req)
      return sendJson(res, await facilitator.verify(paymentPayload, paymentRequirements))
    }

    if (req.method === 'POST' && req.url === '/settle') {
      stats.settleRequests++
      const { paymentPayload, paymentRequirements } = await readFacilitatorRequest(req)
      return sendJson(res, await facilitator.settle(paymentPayload, paymentRequirements))
    }

    res.writeHead(404).end()
  })

  return Object.assign(server, { stats })
}

async function createCoinbaseResourceServer(parameters: {
  facilitatorUrl: string
  token: Address
}): Promise<Http.TestServer> {
  const facilitatorClient = new HTTPFacilitatorClient({
    timeoutMs: 10_000,
    url: parameters.facilitatorUrl,
  })
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network,
    new ExactEvmServer(),
  )
  await resourceServer.initialize()

  const app = express()
  app.use(express.json())
  app.use(
    paymentMiddleware(
      {
        'GET /paid': {
          accepts: {
            maxTimeoutSeconds: 60,
            network,
            payTo: recipient.address,
            price: {
              amount: paymentAmount.toString(),
              asset: parameters.token,
              extra: { name: 'USDC', version: '2' },
            },
            scheme: 'exact',
          },
          description: 'Coinbase x402 interoperability fixture',
        },
      },
      resourceServer,
      undefined,
      undefined,
      false,
    ),
  )
  app.get('/paid', (_req, res) => res.send('paid by mppx'))

  const server = app.listen(0)
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return Http.wrapServer(server, { port, url: `http://localhost:${port}` })
}

function createMppxClient(token: Address) {
  const asset = evmClient.assets.define({
    address: token,
    decimals: 6,
    network,
    transfer: { name: 'USDC', type: 'eip3009', version: '2' },
  })

  return ClientMppx.create({
    methods: [
      evmClient.charge({
        account: payer,
        currencies: [asset],
        maxAmount: '0.02',
        networks: [chainId],
      }),
    ],
    orderChallenges: (candidates) =>
      [...candidates].sort(
        (a, b) => Number(ChallengeBrand.is(b.challenge)) - Number(ChallengeBrand.is(a.challenge)),
      ),
    polyfill: false,
  })
}

function createMppxProxy(harness: CoinbaseHarness): Proxy.Proxy {
  const asset = evmServer.assets.define({
    address: harness.token,
    decimals: 6,
    network,
    transfer: { name: 'USDC', type: 'eip3009', version: '2' },
  })
  const payment = ServerMppx.create({
    methods: [
      evmServer.charge({
        currency: asset,
        recipient: recipient.address,
        x402: { facilitator: harness.facilitator.url },
      }),
    ],
    secretKey: 'coinbase-x402-integration-secret-key',
  })

  return Proxy.create({
    basePath: '/proxy',
    async fetch() {
      return new Response('paid by Coinbase')
    },
    services: [
      {
        baseUrl: 'https://upstream.example.com',
        id: 'coinbase',
        routes: { 'GET /paid': payment.charge({ amount: '0.01' }) },
      },
    ],
  })
}

async function loadArtifact(): Promise<ForgeArtifact> {
  try {
    const path = new URL('../../_/foundry/out/TestUSDC.sol/TestUSDC.json', import.meta.url)
    const artifact = JSON.parse(await readFile(path, 'utf8')) as ForgeArtifact
    if (!artifact.bytecode.object) throw new Error()
    return artifact
  } catch {
    throw new Error('Missing TestUSDC Forge artifact. Run `forge build` before localnet tests.')
  }
}

async function deployToken(artifact: ForgeArtifact): Promise<Address> {
  const hash = await deployContract(payerClient, {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  })
  const receipt = await waitForTransactionReceipt(payerClient, { hash })
  if (!receipt.contractAddress) throw new Error('TestUSDC deploy did not return a contract.')
  return receipt.contractAddress
}

async function mint(
  artifact: ForgeArtifact,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const hash = await writeContract(payerClient, {
    abi: artifact.abi,
    address: token,
    functionName: 'mint',
    args: [to, amount],
  })
  await waitForTransactionReceipt(payerClient, { hash })
}

async function balanceOf(
  artifact: ForgeArtifact,
  token: Address,
  address: Address,
): Promise<bigint> {
  return readContract(payerClient, {
    abi: artifact.abi,
    address: token,
    functionName: 'balanceOf',
    args: [address],
  }) as Promise<bigint>
}

async function readFacilitatorRequest(req: IncomingMessage): Promise<{
  paymentPayload: PaymentPayload
  paymentRequirements: PaymentRequirements
}> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    paymentPayload?: PaymentPayload
    paymentRequirements?: PaymentRequirements
  }
  if (!body.paymentPayload || !body.paymentRequirements)
    throw new Error('Coinbase facilitator request is missing payment fields.')
  return {
    paymentPayload: body.paymentPayload,
    paymentRequirements: body.paymentRequirements,
  }
}

function sendJson(res: import('node:http').ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
