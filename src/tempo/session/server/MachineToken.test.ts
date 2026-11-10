import { Secp256k1 } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import {
  type Address,
  createClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  zeroAddress,
} from 'viem'
import { maxUint256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis, Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow, uint96, type SessionReceipt } from '../precompile/Protocol.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelStore from './ChannelStore.js'
import { session } from './Session.js'

const payerPrivateKey = '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const payer = privateKeyToAccount(payerPrivateKey)
const chainId = 42431
const mach = defaults.machineToken[chainId].token as Address
const token = '0x20c0000000000000000000000000000000000001' as Address
const otherToken = '0x20c0000000000000000000000000000000000009' as Address
const payee = '0x0000000000000000000000000000000000000002' as Address
const testChain = defineChain({
  id: chainId,
  name: 'Tempo Test',
  nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
  rpcUrls: { default: { http: ['http://localhost'] } },
})

type RpcCall = { method: string; params?: unknown }
type OpenPayload = Extract<SessionCredentialPayload, { action: 'open' }>
type VerifyRequest = Parameters<ReturnType<typeof session>['verify']>[0]['request']

const transferPolicyIdSelector = encodeFunctionData({
  abi: Abis.tip20,
  functionName: 'transferPolicyId',
}).slice(0, 10)

function createServerClient(
  options: {
    calls?: RpcCall[]
    open?: OpenPayload | undefined
    policy?: { id: bigint; authorized: boolean } | undefined
  } = {},
) {
  const { calls = [], open, policy = { id: 1n, authorized: true } } = options
  let sent = false
  return createClient({
    account: payer,
    chain: testChain,
    transport: custom(
      {
        async request(args) {
          calls.push(args)
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          if (args.method === 'eth_sendRawTransaction') {
            sent = true
            return `0x${'aa'.repeat(32)}`
          }
          if (args.method === 'eth_sendRawTransactionSync' && open)
            return receipt([openedLog(open)])
          if (args.method === 'eth_getTransactionReceipt')
            return sent && open ? receipt([openedLog(open)]) : null
          if (args.method === 'eth_call') {
            const { data, to } = (args.params as [{ data?: Hex; to?: Address }])[0]
            // Simulations of credential transactions succeed.
            if (!to || !data) return '0x'
            if (
              to.toLowerCase() === mach.toLowerCase() &&
              data.startsWith(transferPolicyIdSelector)
            )
              return encodeFunctionResult({
                abi: Abis.tip20,
                functionName: 'transferPolicyId',
                result: policy.id,
              })
            if (to.toLowerCase() !== tip20ChannelEscrow.toLowerCase())
              return encodeFunctionResult({
                abi: Abis.tip403Registry,
                functionName: 'isAuthorizedRecipient',
                result: policy.authorized,
              })
            const state = { settled: 0n, deposit: 1_000n, closeRequestedAt: 0 }
            if (open && data.startsWith(getChannelSelector(open)))
              return encodeFunctionResult({
                abi: escrowAbi,
                functionName: 'getChannel',
                result: { descriptor: open.descriptor, state },
              })
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'getChannelState',
              result: state,
            })
          }
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      },
      { retryCount: 0 },
    ),
  })
}

function getChannelSelector(open: OpenPayload) {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'getChannel',
    args: [open.descriptor],
  }).slice(0, 10)
}

function receipt(logs: readonly Record<string, unknown>[]) {
  return {
    blockHash: `0x${'01'.repeat(32)}`,
    blockNumber: '0x1',
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    from: payer.address,
    gasUsed: '0x1',
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    to: tip20ChannelEscrow,
    transactionHash: `0x${'aa'.repeat(32)}`,
    transactionIndex: '0x0',
    type: '0x76',
  }
}

function openedLog(payload: OpenPayload) {
  return {
    address: tip20ChannelEscrow,
    data: encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint96' },
      ],
      [
        payload.descriptor.operator,
        payload.descriptor.token,
        payload.descriptor.authorizedSigner,
        payload.descriptor.salt,
        payload.descriptor.expiringNonceHash,
        1_000n,
      ],
    ),
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: 'ChannelOpened',
      args: { channelId: payload.channelId, payer: payer.address, payee },
    }),
  }
}

let saltCounter = 0

/** Re-signs a payer transaction for a fee payer to co-sign. */
function sponsor(serializedTransaction: Hex): Hex {
  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const envelope = TxEnvelopeTempo.from({
    ...transaction,
    feePayerSignature: null,
    gas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    nonceKey: maxUint256,
    validBefore: Math.floor(Date.now() / 1_000) + 600,
  } as never)
  return TxEnvelopeTempo.serialize(envelope, {
    signature: Secp256k1.sign({
      payload: TxEnvelopeTempo.getSignPayload(envelope),
      privateKey: payerPrivateKey,
    }),
  }) as Hex
}

async function createOpenPayload(
  channelToken: Address,
  feeToken: Address = token,
  sponsored = false,
) {
  const salt = `0x${(++saltCounter).toString(16).padStart(64, '0')}` as Hex
  const unsponsored = (await Transaction.serialize({
    chainId,
    calls: [
      {
        to: tip20ChannelEscrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: 'open',
          args: [payee, zeroAddress, channelToken, uint96(1_000n), salt, payer.address],
        }),
      },
    ],
    feeToken,
    nonce: 0,
  })) as Hex
  const transaction = sponsored ? sponsor(unsponsored) : unsponsored
  const signed = Transaction.deserialize(transaction as Transaction.TransactionSerializedTempo)
  const descriptor = {
    authorizedSigner: payer.address,
    expiringNonceHash: Channel.computeExpiringNonceHash(
      sponsored
        ? Channel.transactionForExpiringNonceHash({ feePayer: true, transaction: signed })
        : (signed as Channel.ExpiringNonceTransaction),
      { sender: payer.address },
    ),
    operator: zeroAddress,
    payee,
    payer: payer.address,
    salt,
    token: channelToken,
  } satisfies Channel.ChannelDescriptor
  const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
  const signature = await Voucher.signVoucher(
    createServerClient(),
    payer,
    { channelId, cumulativeAmount: 100n },
    tip20ChannelEscrow,
    chainId,
  )
  return {
    action: 'open',
    type: 'transaction',
    authorizedSigner: payer.address,
    channelId,
    cumulativeAmount: '100',
    descriptor,
    signature,
    transaction,
  } satisfies OpenPayload
}

function createServer(
  parameters: Partial<session.Parameters> & { client?: ReturnType<typeof createServerClient> } = {},
) {
  const { client = createServerClient(), ...rest } = parameters
  const rawStore = Store.memory()
  const method = session({
    amount: '100',
    chainId,
    currency: token,
    decimals: 0,
    recipient: payee,
    store: rawStore,
    unitType: 'request',
    getClient: () => client,
    ...rest,
  })
  return { method, store: ChannelStore.fromStore(rawStore) }
}

async function issueRequest(
  method: ReturnType<typeof session>,
  request: Record<string, unknown> = {},
) {
  return Methods.session.schema.request.parse(
    await method.request!({
      credential: null,
      request: {
        amount: '100',
        currency: token,
        decimals: 0,
        recipient: payee,
        unitType: 'request',
        ...request,
      },
    } as never),
  )
}

function makeChallenge(request: ReturnType<typeof Methods.session.schema.request.parse>) {
  return {
    id: 'challenge-id',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'session',
    request,
  }
}

describe('session machineTokenEnabled', () => {
  test('flags challenges and checks that MACH may pay the recipient', async () => {
    const calls: RpcCall[] = []
    const { method } = createServer({
      client: createServerClient({ calls }),
      machineTokenEnabled: true,
    })

    const request = await issueRequest(method)

    expect(request.currency).toBe(token)
    expect(request.methodDetails.machineTokenDirect).toBe(true)
    const policyCalls = calls.filter(
      ({ method, params }) =>
        method === 'eth_call' &&
        (params as [{ to: Address }])[0].to.toLowerCase() === mach.toLowerCase(),
    )
    expect(policyCalls).toHaveLength(1)
  })

  test('rejects a recipient MACH may not pay', async () => {
    const { method } = createServer({
      client: createServerClient({ policy: { id: 7n, authorized: false } }),
      machineTokenEnabled: true,
    })

    await expect(issueRequest(method)).rejects.toThrow('transfer policy forbids it')
  })

  test('does not flag challenges or read policies when disabled', async () => {
    const calls: RpcCall[] = []
    const { method } = createServer({ client: createServerClient({ calls }) })

    const request = await issueRequest(method, { machineTokenDirect: true })

    expect(request.methodDetails.machineTokenDirect).toBeUndefined()
    expect(calls.filter(({ method }) => method === 'eth_call')).toEqual([])
  })

  test('does not flag sessions priced in MACH', async () => {
    const { method } = createServer({ currency: mach, machineTokenEnabled: true })

    const request = await issueRequest(method, { currency: mach })

    expect(request.methodDetails.machineTokenDirect).toBeUndefined()
  })

  test('throws on chains without MACH', async () => {
    const otherChain = defineChain({ ...testChain, id: 1337 })
    const client = createClient({
      chain: otherChain,
      transport: custom({
        async request() {
          throw new Error('unexpected rpc request')
        },
      }),
    })
    const { method } = createServer({
      chainId: 1337,
      client: client as never,
      machineTokenEnabled: true,
    })

    await expect(issueRequest(method)).rejects.toThrow(
      'Machine tokens are not supported on chainId 1337.',
    )
  })

  test('accepts a MACH channel for a flagged challenge', async () => {
    const { method } = createServer({ machineTokenEnabled: true })
    const request = await issueRequest(method)
    const payload = await createOpenPayload(mach)

    const validation = await method.validate!({
      credential: { challenge: makeChallenge(request), payload },
      request: request as unknown as VerifyRequest,
    } as never)

    expect(validation.details).toEqual({ action: 'open', channelId: payload.channelId })
  })

  test('rejects a MACH channel without the flag', async () => {
    const { method } = createServer()
    const request = await issueRequest(method)
    const payload = await createOpenPayload(mach)

    await expect(
      method.validate!({
        credential: { challenge: makeChallenge(request), payload },
        request: request as unknown as VerifyRequest,
      } as never),
    ).rejects.toThrow('channel descriptor token does not match server token')
  })

  test('rejects a MACH channel when the route no longer offers MACH', async () => {
    const { method } = createServer({ machineTokenEnabled: true })
    const request = await issueRequest(method)
    const { machineTokenDirect: _, ...methodDetails } = request.methodDetails
    const payload = await createOpenPayload(mach)

    await expect(
      method.validate!({
        credential: { challenge: makeChallenge(request), payload },
        request: { ...request, methodDetails } as unknown as VerifyRequest,
      } as never),
    ).rejects.toThrow('channel descriptor token does not match server token')
  })

  test('rejects channels in other tokens for a flagged challenge', async () => {
    const { method } = createServer({ machineTokenEnabled: true })
    const request = await issueRequest(method)
    const payload = await createOpenPayload(otherToken)

    await expect(
      method.validate!({
        credential: { challenge: makeChallenge(request), payload },
        request: request as unknown as VerifyRequest,
      } as never),
    ).rejects.toThrow('channel descriptor token does not match server token')
  })

  test('sponsors MACH opens with the challenge currency as fee token', async () => {
    const calls: RpcCall[] = []
    const payload = await createOpenPayload(mach, token, true)
    const { method } = createServer({
      client: createServerClient({ calls, open: payload }),
      feePayer: payer,
      machineTokenEnabled: true,
    })
    const request = await issueRequest(method)

    await method.verify({
      credential: { challenge: makeChallenge(request), payload },
      request: { ...request, feePayer: payer } as unknown as VerifyRequest,
    } as never)

    const sent = calls.find(({ method }) => method.startsWith('eth_sendRawTransaction'))
    const transaction = Transaction.deserialize(
      (sent!.params as [Transaction.TransactionSerializedTempo])[0],
    )
    expect(String(transaction.feeToken).toLowerCase()).toBe(token.toLowerCase())
  })

  test('opens a MACH channel and reports MACH as the funding currency', async () => {
    const payload = await createOpenPayload(mach)
    const { method, store } = createServer({
      client: createServerClient({ open: payload }),
      machineTokenEnabled: true,
    })
    const request = await issueRequest(method)

    const result = (await method.verify({
      credential: { challenge: makeChallenge(request), payload },
      request: request as unknown as VerifyRequest,
    } as never)) as SessionReceipt & { fundingCurrency?: string }

    expect(result.acceptedCumulative).toBe('100')
    expect(result.fundingCurrency).toBe(mach)
    const stored = await store.getChannel(payload.channelId)
    expect(stored && ChannelStore.isPrecompileState(stored) && stored.token).toBe(mach)
  })
})
