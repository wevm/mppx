import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { isDeepStrictEqual } from 'node:util'

import { evm as evmClient, Mppx as ClientMppx } from 'mppx/client'
import { evm, Mppx as ServerMppx, NodeListener, Request as ServerRequest } from 'mppx/server'
import type { Abi, Address, Hex } from 'viem'
import {
  createClient,
  defineChain,
  getAddress,
  http as viem_http,
  parseSignature,
  parseUnits,
  recoverTypedDataAddress,
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

import * as evm_Types from '../evm/Types.js'
import * as Header from './Header.js'
import * as x402_ChallengeBrand from './internal/ChallengeBrand.js'
import * as Types from './Types.js'

const runLocalnet = process.env.X402_LOCALNET === 'true'
const describeLocalnet = runLocalnet ? describe : describe.skip

const chainId = 31_337
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
const facilitatorClient = createClient({ account: facilitatorAccount, chain, transport })

type ForgeArtifact = {
  abi: Abi
  bytecode: { object: Hex }
}

type Harness = {
  artifact: ForgeArtifact
  asset: ReturnType<typeof evm.assets.define>
  facilitator: Http.TestServer
  token: Address
}

describeLocalnet('x402 exact localnet settlement', () => {
  test('settles x402 exact EIP-3009 payment on localnet', async () => {
    const harness = await setupHarness()
    const paidServer = await createPaidServer(harness)

    try {
      const challenge = await fetch(`${paidServer.url}/paid`)
      expect(challenge.status).toBe(402)
      const paymentRequiredHeader = challenge.headers.get(Types.paymentRequiredHeader)
      expect(paymentRequiredHeader).toBeTruthy()

      const paymentRequired = Header.decodePaymentRequired(paymentRequiredHeader!)
      expect(paymentRequired.x402Version).toBe(2)
      expect(paymentRequired.accepts[0]).toMatchObject({
        amount: paymentAmount.toString(),
        asset: getAddress(harness.token),
        network: `eip155:${chainId}`,
        payTo: recipient.address,
        scheme: 'exact',
      })

      const payerBefore = await balanceOf(harness, payer.address)
      const recipientBefore = await balanceOf(harness, recipient.address)
      const payment = createX402Client(harness.asset)
      const response = await payment.fetch(`${paidServer.url}/paid`)

      if (response.status !== 200)
        throw new Error(`Expected paid response, got ${response.status}: ${await response.text()}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('paid')

      const paymentResponseHeader = response.headers.get(Types.paymentResponseHeader)
      expect(paymentResponseHeader).toBeTruthy()
      const paymentResponse = Header.decodePaymentResponse(paymentResponseHeader!)
      expect(paymentResponse).toMatchObject({
        network: `eip155:${chainId}`,
        payer: getAddress(payer.address),
        success: true,
      })

      const receipt = await waitForTransactionReceipt(payerClient, {
        hash: paymentResponse.transaction as Hex,
      })
      expect(receipt.status).toBe('success')
      expect(await balanceOf(harness, payer.address)).toBe(payerBefore - paymentAmount)
      expect(await balanceOf(harness, recipient.address)).toBe(recipientBefore + paymentAmount)
    } finally {
      paidServer.close()
      harness.facilitator.close()
    }
  })

  test('rejects replayed localnet x402 payment', async () => {
    const harness = await setupHarness()
    const paidServer = await createPaidServer(harness)

    try {
      const payment = createX402Client(harness.asset)
      const challenge = await payment.rawFetch(`${paidServer.url}/paid`)
      expect(challenge.status).toBe(402)

      const credential = await payment.createCredential(pureX402Challenge(challenge))
      const recipientBefore = await balanceOf(harness, recipient.address)

      const first = await payment.rawFetch(`${paidServer.url}/paid`, {
        headers: { [Types.paymentSignatureHeader]: credential },
      })
      expect(first.status).toBe(200)

      const second = await payment.rawFetch(`${paidServer.url}/paid`, {
        headers: { [Types.paymentSignatureHeader]: credential },
      })
      expect(second.status).toBe(402)
      expect(await balanceOf(harness, recipient.address)).toBe(recipientBefore + paymentAmount)
      expect(facilitatorStats(harness.facilitator).settleRequests).toBe(1)
    } finally {
      paidServer.close()
      harness.facilitator.close()
    }
  })
})

async function setupHarness(): Promise<Harness> {
  const artifact = await loadArtifact()
  const token = await deployToken(artifact)
  const asset = evm.assets.define({
    address: token,
    decimals: 6,
    network: `eip155:${chainId}`,
    transfer: {
      name: 'USDC',
      type: 'eip3009',
      version: '2',
    },
  })

  await mint(artifact, token, payer.address, parseUnits('1000', 6))

  return {
    artifact,
    asset,
    facilitator: await createFacilitator({ artifact, token }),
    token,
  }
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

async function balanceOf(harness: Harness, address: Address): Promise<bigint> {
  return readContract(payerClient, {
    abi: harness.artifact.abi,
    address: harness.token,
    functionName: 'balanceOf',
    args: [address],
  }) as Promise<bigint>
}

async function authorizationState(parameters: {
  artifact: ForgeArtifact
  from: Address
  nonce: Hex
  token: Address
}): Promise<boolean> {
  return readContract(payerClient, {
    abi: parameters.artifact.abi,
    address: parameters.token,
    functionName: 'authorizationState',
    args: [parameters.from, parameters.nonce],
  }) as Promise<boolean>
}

async function createPaidServer(harness: Harness): Promise<Http.TestServer> {
  const payment = ServerMppx.create({
    methods: [
      evm.charge({
        currency: harness.asset,
        recipient: recipient.address,
        x402: { facilitator: harness.facilitator.url },
      }),
    ],
    secretKey: 'x402-localnet-secret-key-32-bytes',
  })
  const paid = payment.evm.charge({ amount: '0.01', description: 'localnet x402' })

  return Http.createServer(async (req, res) => {
    if (req.url !== '/paid') {
      return NodeListener.sendResponse(res, new Response('not found', { status: 404 }))
    }

    const result = await paid(ServerRequest.fromNodeListener(req, res))
    if (result.status === 402) return NodeListener.sendResponse(res, result.challenge)
    return NodeListener.sendResponse(res, result.withReceipt(new Response('paid')))
  })
}

function createX402Client(asset: ReturnType<typeof evm.assets.define>) {
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
        (a, b) =>
          Number(x402_ChallengeBrand.is(b.challenge)) - Number(x402_ChallengeBrand.is(a.challenge)),
      ),
    polyfill: false,
  })
}

async function createFacilitator(parameters: {
  artifact: ForgeArtifact
  token: Address
}): Promise<Http.TestServer> {
  const stats = { settleRequests: 0, verifyRequests: 0 }
  const server = await Http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      return NodeListener.sendResponse(res, new Response('not found', { status: 404 }))
    }

    const body = await readJson(req)
    if (req.url === '/verify') {
      stats.verifyRequests++
      const verified = await verifyPayment({ ...parameters, body })
      return NodeListener.sendResponse(res, Response.json(verified))
    }

    if (req.url === '/settle') {
      stats.settleRequests++
      const settled = await settlePayment({ ...parameters, body })
      return NodeListener.sendResponse(res, Response.json(settled))
    }

    return NodeListener.sendResponse(res, new Response('not found', { status: 404 }))
  })

  return Object.assign(server, { x402LocalnetStats: stats })
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

async function verifyPayment(parameters: {
  artifact: ForgeArtifact
  body: unknown
  token: Address
}): Promise<Types.VerifyResponse> {
  try {
    const { paymentPayload, paymentRequirements, x402Version } = parseFacilitatorRequest(
      parameters.body,
    )
    if (x402Version !== 2) return invalid('unsupported x402 version')
    if (!isDeepStrictEqual(paymentPayload.accepted, paymentRequirements))
      return invalid('payment payload accepted requirements mismatch')
    if (!('authorization' in paymentPayload.payload))
      return invalid('expected EIP-3009 authorization payload')

    const authorization = paymentPayload.payload.authorization
    if (getAddress(paymentRequirements.payTo as Address) !== getAddress(authorization.to))
      return invalid('authorization recipient mismatch')
    if (paymentRequirements.amount !== authorization.value)
      return invalid('authorization amount mismatch')

    const now = BigInt(Math.floor(Date.now() / 1000))
    if (BigInt(authorization.validAfter) > now) return invalid('authorization is not valid yet')
    if (BigInt(authorization.validBefore) <= now) return invalid('authorization has expired')

    const recovered = await recoverTypedDataAddress({
      domain: {
        chainId,
        name: stringExtra(paymentRequirements, 'name'),
        verifyingContract: getAddress(paymentRequirements.asset as Address),
        version: stringExtra(paymentRequirements, 'version'),
      },
      message: {
        from: getAddress(authorization.from),
        nonce: authorization.nonce as Hex,
        to: getAddress(authorization.to),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        value: BigInt(authorization.value),
      },
      primaryType: 'TransferWithAuthorization',
      signature: paymentPayload.payload.signature as Hex,
      types: evm_Types.authorizationTypes,
    })
    if (getAddress(recovered) !== getAddress(authorization.from))
      return invalid('authorization signature mismatch')

    const used = await authorizationState({
      artifact: parameters.artifact,
      from: authorization.from as Address,
      nonce: authorization.nonce as Hex,
      token: parameters.token,
    })
    if (used) return invalid('authorization nonce already used')

    return { isValid: true, payer: getAddress(authorization.from) }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'invalid payment')
  }
}

async function settlePayment(parameters: {
  artifact: ForgeArtifact
  body: unknown
  token: Address
}): Promise<Types.SettleResponse> {
  const verified = await verifyPayment(parameters)
  const { paymentPayload, paymentRequirements } = parseFacilitatorRequest(parameters.body)
  const network = paymentRequirements.network

  if (!verified.isValid) {
    return {
      errorReason: verified.invalidReason ?? verified.invalidMessage ?? 'verification failed',
      network,
      success: false,
      transaction: '',
    }
  }
  if (!('authorization' in paymentPayload.payload)) {
    return {
      errorReason: 'expected EIP-3009 authorization payload',
      network,
      success: false,
      transaction: '',
    }
  }

  try {
    const { authorization, signature } = paymentPayload.payload
    const { r, s, v, yParity } = parseSignature(signature as Hex)
    const hash = await writeContract(facilitatorClient, {
      abi: parameters.artifact.abi,
      address: parameters.token,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        Number(v ?? (yParity === 0 ? 27 : 28)),
        r,
        s,
      ],
    })
    await waitForTransactionReceipt(facilitatorClient, { hash })
    return {
      amount: authorization.value,
      network,
      payer: getAddress(authorization.from),
      success: true,
      transaction: hash,
    }
  } catch (error) {
    return {
      errorReason: error instanceof Error ? error.message : 'settlement failed',
      network,
      success: false,
      transaction: '',
    }
  }
}

function parseFacilitatorRequest(body: unknown): {
  paymentPayload: Types.PaymentPayload
  paymentRequirements: Types.PaymentRequirements
  x402Version: unknown
} {
  if (!body || typeof body !== 'object') throw new Error('invalid facilitator request')
  const record = body as Record<string, unknown>
  return {
    paymentPayload: Types.PaymentPayloadSchema.parse(record.paymentPayload),
    paymentRequirements: Types.PaymentRequirementsSchema.parse(record.paymentRequirements),
    x402Version: record.x402Version,
  }
}

function stringExtra(paymentRequirements: Types.PaymentRequirements, key: string): string {
  const value = paymentRequirements.extra?.[key]
  if (typeof value !== 'string') throw new Error(`missing ${key} metadata`)
  return value
}

function invalid(reason: string): Types.VerifyResponse {
  return { invalidReason: reason, isValid: false }
}

function pureX402Challenge(response: Response): Response {
  const paymentRequired = response.headers.get(Types.paymentRequiredHeader)
  if (!paymentRequired) throw new Error('Missing PAYMENT-REQUIRED header.')
  return new Response(null, {
    headers: { [Types.paymentRequiredHeader]: paymentRequired },
    status: 402,
  })
}

function facilitatorStats(server: Http.TestServer): {
  settleRequests: number
  verifyRequests: number
} {
  return (
    server as Http.TestServer & {
      x402LocalnetStats: { settleRequests: number; verifyRequests: number }
    }
  ).x402LocalnetStats
}
