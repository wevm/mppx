import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'

import { x402Facilitator } from '@x402/core/facilitator'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { toFacilitatorEvmSigner } from '@x402/evm'
import { ExactEvmScheme as ExactEvmFacilitator } from '@x402/evm/exact/facilitator'
import { ExactEvmScheme as ExactEvmServer } from '@x402/evm/exact/server'
import { paymentMiddleware } from '@x402/express'
import express from 'express'
import { evm as evmClient, Mppx } from 'mppx/client'
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

import * as Header from './Header.js'
import * as ChallengeBrand from './internal/ChallengeBrand.js'
import * as Types from './Types.js'

const runLocalnet = process.env.X402_LOCALNET === 'true'
const describeLocalnet = runLocalnet ? describe : describe.skip

const chainId = 31_337
const network = `eip155:${chainId}` as const
const rpcUrl = process.env.X402_ANVIL_RPC_URL ?? 'http://127.0.0.1:18546'
const mnemonic = 'test test test test test test test test test test test junk'
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

type OfficialFacilitatorServer = Http.TestServer & {
  stats: {
    settleRequests: number
    supportedRequests: number
    verifyRequests: number
  }
}

describeLocalnet('official x402 resource server interoperability', () => {
  test('pays an official resource server with the mppx client', { timeout: 60_000 }, async () => {
    const artifact = await loadArtifact()
    const token = await deployToken(artifact)
    await mint(artifact, token, payer.address, parseUnits('1000', 6))

    const facilitator = await createOfficialFacilitator()
    const resourceServer = await createOfficialResourceServer({
      facilitatorUrl: facilitator.url,
      token,
    })

    try {
      const challenge = await fetch(`${resourceServer.url}/paid`)
      expect(challenge.status).toBe(402)

      const paymentRequiredHeader = challenge.headers.get(Types.paymentRequiredHeader)
      expect(paymentRequiredHeader).toBeTruthy()
      expect(Header.decodePaymentRequired(paymentRequiredHeader!)).toMatchObject({
        accepts: [
          {
            amount: paymentAmount.toString(),
            asset: token.toLowerCase(),
            network,
            payTo: recipient.address,
            scheme: 'exact',
          },
        ],
        x402Version: 2,
      })

      const payerBefore = await balanceOf(artifact, token, payer.address)
      const recipientBefore = await balanceOf(artifact, token, recipient.address)
      const response = await createMppxClient(token).fetch(`${resourceServer.url}/paid`)

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
      expect(await balanceOf(artifact, token, payer.address)).toBe(payerBefore - paymentAmount)
      expect(await balanceOf(artifact, token, recipient.address)).toBe(
        recipientBefore + paymentAmount,
      )
      expect(facilitator.stats).toEqual({
        settleRequests: 1,
        supportedRequests: 1,
        verifyRequests: 1,
      })
    } finally {
      resourceServer.close()
      facilitator.close()
    }
  })
})

async function createOfficialFacilitator(): Promise<OfficialFacilitatorServer> {
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

async function createOfficialResourceServer(parameters: {
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
          description: 'Official x402 interoperability fixture',
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

  return Mppx.create({
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
    throw new Error('Official facilitator request is missing payment fields.')
  return {
    paymentPayload: body.paymentPayload,
    paymentRequirements: body.paymentRequirements,
  }
}

function sendJson(res: import('node:http').ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
