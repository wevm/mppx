import { Challenge, Credential } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import {
  type BaseError,
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  HttpRequestError,
  keccak256,
  maxUint256,
  SocketClosedError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTransaction } from 'viem/actions'
import { tempoModerato } from 'viem/chains'
import { Abis } from 'viem/tempo'
import { expect, test, vi } from 'vp/test'

import * as Store from '../../Store.js'
import * as Attribution from '../Attribution.js'

const url = 'https://rpc.example.com'
// Ambiguous: the transaction may be pooled, so its receipt is polled for.
const alreadyKnown = { code: -32000, message: 'already known' }
const knownTransaction = { code: -32000, message: 'known transaction: 0x12' }
const syncTimeout = { code: 4, message: 'Transaction was added to the mempool but not confirmed' }
const transportTimeout = new TimeoutError({ body: {}, url })
const aborted = new DOMException('The operation was aborted.', 'AbortError')
const networkFailure = new HttpRequestError({ cause: new Error('socket hang up'), url })
const gateway = new HttpRequestError({ status: 502, url })
const socketClosed = new SocketClosedError({ url })
// Definitive: the node rejected the request, so no receipt is polled for.
const methodNotFound = { code: -32601, message: 'method not found' }
const invalidParams = { code: -32602, message: 'invalid params' }
const insufficientFunds = { code: -32000, message: 'insufficient funds for gas * price + value' }
const invalidSignature = { code: -32000, message: 'invalid signature' }
const rateLimited = new HttpRequestError({ status: 429, url })
const unknownType = { code: -32000, message: 'unknown transaction type' }

test.each([
  { name: 'included', sponsored: false, outcome: 'included', error: gateway },
  { name: 'sponsored', sponsored: true, outcome: 'included', error: gateway },
  { name: 'sponsored pending', sponsored: true, outcome: 'pending', error: syncTimeout },
  { name: 'missing receipt', sponsored: false, outcome: 'missing', error: alreadyKnown },
  { name: 'lookup error', sponsored: false, outcome: 'lookup-error', error: gateway },
  { name: 'reverted receipt', sponsored: false, outcome: 'reverted', error: gateway },
  { name: 'wrong transfer', sponsored: false, outcome: 'wrong-transfer', error: gateway },
  { name: 'wrong hash', sponsored: false, outcome: 'wrong-hash', error: gateway },
  { name: 'normal broadcast', sponsored: false, outcome: 'normal', error: gateway },
  { name: 'already known', sponsored: false, outcome: 'pending', error: alreadyKnown },
  { name: 'known transaction', sponsored: false, outcome: 'pending', error: knownTransaction },
  { name: 'sync timeout', sponsored: false, outcome: 'pending', error: syncTimeout },
  { name: 'transport timeout', sponsored: false, outcome: 'pending', error: transportTimeout },
  { name: 'aborted', sponsored: false, outcome: 'pending', error: aborted },
  { name: 'network failure', sponsored: false, outcome: 'pending', error: networkFailure },
  { name: 'gateway error', sponsored: false, outcome: 'pending', error: gateway },
  { name: 'socket closed', sponsored: false, outcome: 'pending', error: socketClosed },
  { name: 'local deadline', sponsored: false, outcome: 'pending', error: 'hang' },
  { name: 'local deadline missing', sponsored: false, outcome: 'missing', error: 'hang' },
  { name: 'expired', sponsored: false, outcome: 'expired', error: alreadyKnown },
  { name: 'expired mined', sponsored: false, outcome: 'expired-mined', error: alreadyKnown },
  { name: 'expiring', sponsored: false, outcome: 'expiring', error: alreadyKnown },
  { name: 'method not found', sponsored: false, outcome: 'rejected', error: methodNotFound },
  { name: 'invalid params', sponsored: false, outcome: 'rejected', error: invalidParams },
  { name: 'insufficient funds', sponsored: false, outcome: 'rejected', error: insufficientFunds },
  { name: 'invalid signature', sponsored: false, outcome: 'rejected', error: invalidSignature },
  { name: 'rate limited', sponsored: false, outcome: 'rejected', error: rateLimited },
  { name: 'unknown transaction type', sponsored: false, outcome: 'rejected', error: unknownType },
] as const)('synchronous charge recovery: $name', async ({ sponsored, outcome, error }) => {
  const payer = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const sponsor = privateKeyToAccount(`0x${'02'.repeat(32)}`)
  const recipient = '0x2222222222222222222222222222222222222222'
  const currency = '0x20c0000000000000000000000000000000000001'
  const otherHash = `0x${'12'.repeat(32)}` as const
  // Expiry cases use a long budget so `validBefore` bounds the receipt wait instead.
  const expiry = outcome === 'expired' || outcome === 'expired-mined' || outcome === 'expiring'
  const confirmationTimeoutMs = expiry ? 10_000 : 200
  const calls: string[] = []
  const lookupHashes: string[] = []
  let blockNumber = 0
  let syncParams: unknown[] = []
  const onPaymentSuccess = vi.fn()
  const store = Store.memory()
  let finalHash: `0x${string}`
  let memo: `0x${string}`

  const client = createClient({
    account: payer,
    chain: tempoModerato,
    pollingInterval: 10,
    transport: custom(
      {
        async request({ method, params }) {
          calls.push(method)
          if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
          if (method === 'eth_call') return '0x'
          if (method === 'eth_blockNumber') return `0x${(++blockNumber).toString(16)}`
          if (method === 'eth_sendRawTransactionSync') {
            syncParams = params
            finalHash = keccak256(params[0])
            if (outcome === 'normal') {
            } else if (error === 'hang') return new Promise(() => {})
            else throw error
          } else if (method === 'eth_getTransactionReceipt') {
            lookupHashes.push(params[0])
            if (outcome === 'missing' || outcome === 'expired' || outcome === 'expiring')
              return null
            if (outcome === 'pending' && lookupHashes.length < 3) return null
            if (outcome === 'lookup-error') throw new Error('Lookup unavailable')
          } else throw new Error(`Unexpected RPC method: ${method}`)

          const transactionHash = outcome === 'wrong-hash' ? otherHash : finalHash
          return {
            blockHash: otherHash,
            blockNumber: '0x1',
            contractAddress: null,
            cumulativeGasUsed: '0x1',
            effectiveGasPrice: '0x1',
            from: payer.address,
            gasUsed: '0x1',
            logs: [
              {
                address: currency,
                blockHash: otherHash,
                blockNumber: '0x1',
                data: encodeAbiParameters(
                  [{ type: 'uint256' }],
                  [outcome === 'wrong-transfer' ? 1n : 1_000_000n],
                ),
                logIndex: '0x0',
                removed: false,
                topics: encodeEventTopics({
                  abi: Abis.tip20,
                  eventName: 'TransferWithMemo',
                  args: { from: payer.address, to: recipient, memo },
                }),
                transactionHash,
                transactionIndex: '0x0',
              },
            ],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: outcome === 'reverted' ? '0x0' : '0x1',
            to: currency,
            transactionHash,
            transactionIndex: '0x0',
            type: '0x76',
          }
        },
      },
      { retryCount: 0 },
    ),
  })
  const server = Mppx.create({
    realm: 'api.example.com',
    secretKey: 'test-secret-key-test-secret-key-32',
    methods: [
      tempo.charge({
        account: recipient,
        confirmationTimeoutMs,
        currency,
        ...(sponsored
          ? { feePayer: sponsor, feeToken: currency, allowedFeeTokens: [currency] }
          : {}),
        getClient: () => client,
        onPaymentSuccess,
        store,
        testnet: true,
      }),
    ],
  })
  const challengeResponse = await server.charge({ amount: '1', decimals: 6 })(
    new Request('https://example.com'),
  )
  if (challengeResponse.status !== 402) throw new Error('Expected challenge')
  const challenge = Challenge.fromResponse(challengeResponse.challenge)
  memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm })
  const signature = await signTransaction(client, {
    account: payer,
    calls: [
      {
        to: currency,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'transferWithMemo',
          args: [recipient, 1_000_000n, memo],
        }),
      },
    ],
    gas: 100_000n,
    ...(sponsored ? { feePayer: true, feeToken: currency, nonceKey: maxUint256 } : {}),
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: 0,
    validBefore:
      Math.floor(Date.now() / 1_000) +
      (outcome === 'expired' || outcome === 'expired-mined' ? -3 : outcome === 'expiring' ? 1 : 25),
  })
  const credential = Credential.serialize(
    Credential.from({ challenge, payload: { signature, type: 'transaction' } }),
  )

  if (
    outcome === 'included' ||
    outcome === 'pending' ||
    outcome === 'normal' ||
    outcome === 'expired-mined'
  ) {
    const receipt = await server.broadcastCredential(credential)
    expect(receipt).toMatchObject({ status: 'success', reference: finalHash! })
    expect(onPaymentSuccess).toHaveBeenCalledOnce()
  } else if (
    outcome === 'missing' ||
    outcome === 'lookup-error' ||
    outcome === 'rejected' ||
    outcome === 'expired' ||
    outcome === 'expiring'
  ) {
    const started = Date.now()
    const thrown = (await server.broadcastCredential(credential).catch((e) => e)) as BaseError
    if (error === 'hang') expect(thrown).toBeInstanceOf(WaitForTransactionReceiptTimeoutError)
    else expect(thrown.walk((cause) => cause === error)).toBe(error)
    if (expiry) expect(Date.now() - started).toBeLessThan(confirmationTimeoutMs / 2)
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  } else {
    await expect(server.broadcastCredential(credential)).rejects.toThrow()
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  }
  expect(syncParams[1]).toBe(Math.floor((confirmationTimeoutMs * 2) / 3))
  const polled = outcome !== 'normal' && outcome !== 'rejected'
  expect(new Set(lookupHashes)).toEqual(new Set(polled ? [finalHash!] : []))
  if (outcome === 'pending') expect(lookupHashes).toHaveLength(3)
  if (outcome === 'expired' || outcome === 'expired-mined') expect(lookupHashes).toHaveLength(1)
  if (sponsored) expect(finalHash!).not.toBe(keccak256(signature))
  await expect(server.broadcastCredential(credential)).rejects.toThrow(
    'Transaction hash has already been used',
  )
  expect(calls.filter((method) => method === 'eth_sendRawTransactionSync')).toHaveLength(1)
})
