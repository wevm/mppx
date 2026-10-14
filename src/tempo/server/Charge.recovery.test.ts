import { Challenge, Credential, Errors } from 'mppx'
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

test.each([
  { name: 'included', sponsored: false, outcome: 'included' },
  { name: 'sponsored', sponsored: true, outcome: 'included' },
  { name: 'missing receipt', sponsored: false, outcome: 'missing' },
  { name: 'receipt lookup error', sponsored: false, outcome: 'lookup-error' },
  { name: 'reverted receipt', sponsored: false, outcome: 'reverted' },
  { name: 'wrong transfer', sponsored: false, outcome: 'wrong-transfer' },
  { name: 'wrong hash', sponsored: false, outcome: 'wrong-hash' },
  { name: 'normal broadcast', sponsored: false, outcome: 'normal' },
] as const)('synchronous charge recovery: $name', async ({ sponsored, outcome }) => {
  const payer = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const sponsor = privateKeyToAccount(`0x${'02'.repeat(32)}`)
  const recipient = '0x2222222222222222222222222222222222222222'
  const currency = '0x20c0000000000000000000000000000000000001'
  const otherHash = `0x${'12'.repeat(32)}` as const
  const broadcastError = { code: -32000, message: 'Broadcast reply unavailable' }
  const calls: string[] = []
  const lookupHashes: string[] = []
  const onPaymentSuccess = vi.fn()
  const store = Store.memory()
  let finalHash: `0x${string}`
  let memo: `0x${string}`

  const client = createClient({
    account: payer,
    chain: tempoModerato,
    transport: custom(
      {
        async request({ method, params }) {
          calls.push(method)
          if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
          if (method === 'eth_call') return '0x'
          if (method === 'eth_sendRawTransactionSync') {
            finalHash = keccak256(params[0])
            if (outcome !== 'normal') throw broadcastError
          } else if (method === 'eth_getTransactionReceipt') {
            lookupHashes.push(params[0])
            if (outcome === 'missing') return null
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

  if (outcome === 'included' || outcome === 'normal') {
    const receipt = await server.broadcastCredential(credential)
    expect(receipt).toMatchObject({ status: 'success', reference: finalHash! })
    expect(onPaymentSuccess).toHaveBeenCalledOnce()
  } else if (outcome === 'missing' || outcome === 'lookup-error') {
    await expect(server.broadcastCredential(credential)).rejects.toMatchObject({
      code: broadcastError.code,
      details: broadcastError.message,
    })
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  } else {
    await expect(server.broadcastCredential(credential)).rejects.toThrow()
    expect(onPaymentSuccess).not.toHaveBeenCalled()
  }
  expect(lookupHashes).toEqual(outcome === 'normal' ? [] : [finalHash!])
  if (sponsored) expect(finalHash!).not.toBe(keccak256(signature))
  const replay = await server.broadcastCredential(credential).catch((error: unknown) => error)
  expect(replay).toBeInstanceOf(Errors.CredentialReplayedError)
  expect(replay).toMatchObject({
    message: 'Payment verification failed: Transaction hash has already been used.',
    status: 403,
    type: 'https://paymentauth.org/problems/verification-failed',
  })
  expect(calls.filter((method) => method === 'eth_sendRawTransactionSync')).toHaveLength(1)
})
