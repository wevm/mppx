import { Challenge, Credential } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  maxUint256,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTransaction } from 'viem/actions'
import { tempoModerato } from 'viem/chains'
import { Abis } from 'viem/tempo'
import { expect, test, vi } from 'vp/test'

import * as Store from '../../Store.js'
import * as Attribution from '../Attribution.js'

const replyError = { code: -32000, message: 'Broadcast reply unavailable' }
const alreadyKnown = { code: -32000, message: 'already known' }
const timedOut = { code: 4, message: 'Transaction was not confirmed within 200ms' }

test.each([
  { name: 'included', sponsored: false, outcome: 'included', error: replyError },
  { name: 'sponsored', sponsored: true, outcome: 'included', error: replyError },
  { name: 'already known pending', sponsored: false, outcome: 'pending', error: alreadyKnown },
  { name: 'timeout pending', sponsored: false, outcome: 'pending', error: timedOut },
  { name: 'sponsored timeout pending', sponsored: true, outcome: 'pending', error: timedOut },
  { name: 'missing receipt', sponsored: false, outcome: 'missing', error: replyError },
  { name: 'already known missing', sponsored: false, outcome: 'missing', error: alreadyKnown },
  { name: 'timeout missing', sponsored: false, outcome: 'missing', error: timedOut },
  { name: 'receipt lookup error', sponsored: false, outcome: 'lookup-error', error: replyError },
  { name: 'reverted receipt', sponsored: false, outcome: 'reverted', error: replyError },
  { name: 'wrong transfer', sponsored: false, outcome: 'wrong-transfer', error: replyError },
  { name: 'wrong hash', sponsored: false, outcome: 'wrong-hash', error: replyError },
  { name: 'normal broadcast', sponsored: false, outcome: 'normal', error: replyError },
] as const)('synchronous charge recovery: $name', async ({ sponsored, outcome, error }) => {
  const payer = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const sponsor = privateKeyToAccount(`0x${'02'.repeat(32)}`)
  const recipient = '0x2222222222222222222222222222222222222222'
  const currency = '0x20c0000000000000000000000000000000000001'
  const otherHash = `0x${'12'.repeat(32)}` as const
  const confirmationTimeoutMs = 200
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
            if (outcome !== 'normal') throw error
          } else if (method === 'eth_getTransactionReceipt') {
            lookupHashes.push(params[0])
            if (outcome === 'missing') return null
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
    validBefore: Math.floor(Date.now() / 1_000) + 25,
  })
  const credential = Credential.serialize(
    Credential.from({ challenge, payload: { signature, type: 'transaction' } }),
  )

  if (outcome === 'included' || outcome === 'pending' || outcome === 'normal') {
    const receipt = await server.broadcastCredential(credential)
    expect(receipt).toMatchObject({ status: 'success', reference: finalHash! })
    expect(onPaymentSuccess).toHaveBeenCalledOnce()
  } else if (outcome === 'missing' || outcome === 'lookup-error') {
    await expect(server.broadcastCredential(credential)).rejects.toMatchObject({
      details: error.message,
    })
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  } else {
    await expect(server.broadcastCredential(credential)).rejects.toThrow()
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  }
  expect(syncParams[1]).toBe(confirmationTimeoutMs)
  expect(new Set(lookupHashes)).toEqual(new Set(outcome === 'normal' ? [] : [finalHash!]))
  if (outcome === 'pending') expect(lookupHashes).toHaveLength(3)
  if (outcome === 'missing') expect(lookupHashes.length).toBeGreaterThan(1)
  if (sponsored) expect(finalHash!).not.toBe(keccak256(signature))
  await expect(server.broadcastCredential(credential)).rejects.toThrow(
    'Transaction hash has already been used',
  )
  expect(calls.filter((method) => method === 'eth_sendRawTransactionSync')).toHaveLength(1)
})
