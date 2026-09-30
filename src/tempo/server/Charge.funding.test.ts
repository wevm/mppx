import { Challenge, Credential } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import {
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
} from 'viem'
import { tempoModerato } from 'viem/chains'
import { Abis, Addresses } from 'viem/tempo'
import { expect, test } from 'vp/test'

import * as Attribution from '../Attribution.js'

test.each([
  'direct',
  'single call',
  'unrelated transfers',
  'unavailable',
  'different sender',
] as const)('push funding attribution: %s', async (scenario) => {
  const payer = '0x1111111111111111111111111111111111111111'
  const merchant = '0x2222222222222222222222222222222222222222'
  const donor = '0x3333333333333333333333333333333333333333'
  const currency = '0x20c0000000000000000000000000000000000001'
  const hash = `0x${'12'.repeat(32)}` as const
  let memo: `0x${string}`
  const rpcMethods: string[] = []
  const client = createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method }) {
        rpcMethods.push(method)
        if (method === 'eth_getTransactionByHash') {
          if (scenario === 'unavailable') return null
          if (scenario === 'single call')
            return {
              hash,
              from: payer,
              type: '0x2',
              to: currency,
              input: encodeFunctionData({
                abi: Abis.tip20,
                functionName: 'transferWithMemo',
                args: [merchant, 1_000_000n, memo],
              }),
            }
          return {
            hash,
            from: scenario === 'different sender' ? donor : payer,
            type: '0x76',
            calls: [
              {
                to: currency,
                data: encodeFunctionData({
                  abi: Abis.tip20,
                  functionName: 'transferWithMemo',
                  args: [merchant, 1_000_000n, memo],
                }),
              },
              ...(scenario === 'unrelated transfers'
                ? [
                    {
                      to: currency,
                      data: encodeFunctionData({
                        abi: Abis.tip20,
                        functionName: 'transferFrom',
                        args: [donor, payer, 1_000_000n],
                      }),
                    },
                    {
                      to: Addresses.pathUsd,
                      data: encodeFunctionData({
                        abi: Abis.tip20,
                        functionName: 'transfer',
                        args: [donor, 1n],
                      }),
                    },
                  ]
                : []),
            ],
          }
        }
        if (method !== 'eth_getTransactionReceipt') throw new Error(method)
        const log = (
          address: `0x${string}`,
          from: `0x${string}`,
          to: `0x${string}`,
          amount: bigint,
          index: number,
          payment = false,
        ) => ({
          address,
          blockHash: hash,
          blockNumber: '0x1',
          transactionHash: hash,
          transactionIndex: '0x0',
          logIndex: `0x${index.toString(16)}`,
          removed: false,
          topics: payment
            ? encodeEventTopics({
                abi: Abis.tip20,
                eventName: 'TransferWithMemo',
                args: { from, to, memo },
              })
            : encodeEventTopics({ abi: Abis.tip20, eventName: 'Transfer', args: { from, to } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
        })
        return {
          blockHash: hash,
          blockNumber: '0x1',
          transactionHash: hash,
          transactionIndex: '0x0',
          from: payer,
          to: currency,
          status: '0x1',
          type: '0x76',
          gasUsed: '0x1',
          cumulativeGasUsed: '0x1',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          logs: [
            log(currency, payer, merchant, 1_000_000n, 0, true),
            ...(scenario === 'unrelated transfers'
              ? [
                  // A refund cancels the payment's net debit, leaving only unrelated dust.
                  log(currency, donor, payer, 1_000_000n, 1),
                  log(Addresses.pathUsd, payer, donor, 1n, 2),
                ]
              : []),
          ],
        }
      },
    }),
  })
  const server = Mppx.create({
    realm: 'api.example.com',
    secretKey: 'test-secret-key-test-secret-key-32',
    methods: [
      tempo.charge({ getClient: () => client, currency, account: merchant, testnet: true }),
    ],
  })
  const result = await server.charge({ amount: '1', decimals: 6 })(
    new Request('https://example.com'),
  )
  if (result.status !== 402) throw new Error('Expected challenge')
  const challenge = Challenge.fromResponse(result.challenge)
  memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm })
  const credential = Credential.serialize(
    Credential.from({ challenge, payload: { type: 'hash', hash } }),
  )
  await server.validateCredential(credential)
  expect(rpcMethods).toEqual(['eth_getTransactionReceipt'])
  rpcMethods.length = 0
  const receipt = await server.verifyCredential(credential)
  expect(receipt.status).toBe('success')
  expect(receipt.fundingCurrency).toBe(
    scenario === 'direct' || scenario === 'single call' ? currency : undefined,
  )
  expect(rpcMethods).toEqual([
    'eth_getTransactionReceipt',
    'eth_getTransactionReceipt',
    'eth_getTransactionByHash',
  ])
})
