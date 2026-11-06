import { Challenge, Credential } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import {
  type Address,
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  zeroHash,
} from 'viem'
import { tempoModerato } from 'viem/chains'
import { Abis } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Attribution from '../Attribution.js'
import * as Zone from '../internal/zone.js'

const realm = 'api.example.com'
const merchant = '0x2222222222222222222222222222222222222222'
const other = '0x3333333333333333333333333333333333333333'
const sequencer = '0x4444444444444444444444444444444444444444'
const currency = '0x20c0000000000000000000000000000000000001'
const otherCurrency = '0x20c0000000000000000000000000000000000002'
const zoneId = 3
const portal = Zone.portalAddress(zoneId)
const settlementHash = `0x${'ab'.repeat(32)}` as const

type WithdrawalFixture = {
  senderTag: Hex
  memo: Hex
  to?: Address
  token?: Address
  amount?: bigint
  gasLimit?: bigint
  // Event overrides, to model an event that disagrees with the calldata.
  eventTo?: Address
  eventToken?: Address
  eventAmount?: bigint
  callbackSuccess?: boolean
  eventAddress?: Address
  inCalldata?: boolean
}

function setup(
  options: {
    withdrawals?: () => WithdrawalFixture[]
    status?: 'success' | 'reverted'
    logsAvailable?: () => boolean
    zones?: number[]
    zoneSettlementTimeoutMs?: number
  } = {},
) {
  const rpcMethods: string[] = []
  const withdrawals = () => options.withdrawals?.() ?? []

  const processedLog = (w: WithdrawalFixture, index: number) => ({
    address: w.eventAddress ?? portal,
    blockHash: settlementHash,
    blockNumber: '0x10',
    transactionHash: settlementHash,
    transactionIndex: '0x0',
    logIndex: `0x${index.toString(16)}`,
    removed: false,
    topics: encodeEventTopics({
      abi: Abis.zonePortal,
      eventName: 'WithdrawalProcessed',
      args: { to: w.eventTo ?? w.to ?? merchant, senderTag: w.senderTag },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint128' }, { type: 'bool' }],
      [
        w.eventToken ?? w.token ?? currency,
        w.eventAmount ?? w.amount ?? 1_000_000n,
        w.callbackSuccess ?? true,
      ],
    ),
  })

  const client = createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method }) {
        rpcMethods.push(method)
        if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
        if (method === 'eth_blockNumber') return '0x20'
        if (method === 'eth_getLogs')
          return options.logsAvailable?.() === false ? [] : withdrawals().map(processedLog)
        if (method === 'eth_getTransactionByHash')
          return {
            hash: settlementHash,
            from: sequencer,
            type: '0x76',
            calls: [
              {
                to: portal,
                data: encodeFunctionData({
                  abi: Abis.zonePortal,
                  functionName: 'processWithdrawals',
                  args: [
                    withdrawals()
                      .filter((w) => w.inCalldata !== false)
                      .map((w) => ({
                        token: w.token ?? currency,
                        senderTag: w.senderTag,
                        to: w.to ?? merchant,
                        amount: w.amount ?? 1_000_000n,
                        memo: w.memo,
                        gasLimit: w.gasLimit ?? 0n,
                        fallbackNonce: 1n,
                        callbackData: '0x' as const,
                        encryptedSender: '0x' as const,
                      })),
                    zeroHash,
                  ],
                }),
              },
            ],
          }
        if (method === 'eth_getTransactionReceipt')
          return {
            blockHash: settlementHash,
            blockNumber: '0x10',
            transactionHash: settlementHash,
            transactionIndex: '0x0',
            from: sequencer,
            to: portal,
            status: options.status === 'reverted' ? '0x0' : '0x1',
            type: '0x76',
            gasUsed: '0x1',
            cumulativeGasUsed: '0x1',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logsBloom: `0x${'00'.repeat(256)}`,
            logs: withdrawals().map(processedLog),
          }
        throw new Error(`unexpected ${method}`)
      },
    }),
  })

  const server = Mppx.create({
    realm,
    secretKey: 'test-secret-key-test-secret-key-32',
    methods: [
      tempo.charge({
        account: merchant,
        currency,
        getClient: () => client,
        testnet: true,
        zones: options.zones ?? [zoneId],
        ...(options.zoneSettlementTimeoutMs !== undefined && {
          zoneSettlementTimeoutMs: options.zoneSettlementTimeoutMs,
        }),
      }),
    ],
  })

  async function challenge(request: Record<string, unknown> = {}) {
    const result = await server.charge({ amount: '1', decimals: 6, ...request })(
      new Request('https://example.com'),
    )
    if (result.status !== 402) throw new Error('Expected challenge')
    const challenge = Challenge.fromResponse(result.challenge)
    const memo = Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm })
    return { challenge, memo }
  }

  function credential(
    challenge: Challenge.Challenge,
    payload: { senderTag: Hex; hash?: Hex | undefined; zoneId?: number },
  ) {
    return Credential.serialize(
      Credential.from({
        challenge,
        payload: {
          ...(payload.hash !== undefined ? { hash: payload.hash } : {}),
          senderTag: payload.senderTag,
          type: 'zone',
          zoneId: payload.zoneId ?? zoneId,
        },
      }),
    )
  }

  return { challenge, credential, rpcMethods, server }
}

const tagA = `0x${'a1'.repeat(32)}` as const
const tagB = `0x${'b2'.repeat(32)}` as const

describe('tempo.charge zone credentials', () => {
  test('advertises accepted zones in the challenge', async () => {
    const { challenge } = setup({ zones: [3, 7] })
    const { challenge: c } = await challenge()
    expect(c.request.methodDetails).toMatchObject({ zones: [3, 7] })
  })

  test('accepts a settled withdrawal bound to the challenge', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    const receipt = await server.verifyCredential(
      credential(c, { senderTag: tagA, hash: settlementHash }),
    )
    expect(receipt).toMatchObject({ method: 'tempo', reference: settlementHash, status: 'success' })
  })

  test('finds the settlement on Tempo when the credential has no hash', async () => {
    let fixture: WithdrawalFixture[] = []
    let polls = 0
    const { challenge, credential, rpcMethods, server } = setup({
      withdrawals: () => fixture,
      logsAvailable: () => ++polls > 1,
    })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    const receipt = await server.verifyCredential(credential(c, { senderTag: tagA }))
    expect(receipt.reference).toBe(settlementHash)
    expect(rpcMethods.filter((m) => m === 'eth_getLogs').length).toBeGreaterThanOrEqual(2)
  })

  test('fails when the withdrawal does not settle in time', async () => {
    const { challenge, credential, server } = setup({
      logsAvailable: () => false,
      zoneSettlementTimeoutMs: 100,
    })
    const { challenge: c } = await challenge()
    await expect(server.verifyCredential(credential(c, { senderTag: tagA }))).rejects.toThrow(
      'did not settle on Tempo',
    )
  })

  test('rejects a replayed withdrawal', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    const serialized = credential(c, { senderTag: tagA, hash: settlementHash })
    await server.verifyCredential(serialized)
    await expect(server.verifyCredential(serialized)).rejects.toThrow(
      'Zone withdrawal has already been used',
    )
  })

  test('accepts two payments settled in one Tempo transaction', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const a = await challenge()
    const b = await challenge()
    fixture = [
      { senderTag: tagA, memo: a.memo },
      { senderTag: tagB, memo: b.memo },
    ]
    await server.verifyCredential(
      credential(a.challenge, { senderTag: tagA, hash: settlementHash }),
    )
    await server.verifyCredential(
      credential(b.challenge, { senderTag: tagB, hash: settlementHash }),
    )
  })

  test('rejects a withdrawal bound to another challenge', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const a = await challenge()
    const b = await challenge()
    fixture = [{ senderTag: tagA, memo: a.memo }]
    await expect(
      server.verifyCredential(credential(b.challenge, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow('memo is not bound to this challenge')
  })

  test('rejects a withdrawal without an MPP memo', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const { challenge: c } = await challenge()
    fixture = [{ senderTag: tagA, memo: zeroHash }]
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow('memo is not bound to this challenge')
  })

  test.each([
    ['recipient', { eventTo: other, to: other }, 'no matching transfer found'],
    ['amount', { eventAmount: 999_999n, amount: 999_999n }, 'no matching transfer found'],
    ['currency', { eventToken: otherCurrency, token: otherCurrency }, 'no matching transfer found'],
    ['bounced withdrawal', { callbackSuccess: false }, 'Zone withdrawal bounced'],
    ['event from another portal', { eventAddress: Zone.portalAddress(4) }, 'not settled'],
    ['withdrawal missing from calldata', { inCalldata: false }, 'Zone withdrawal not found'],
    ['callback withdrawal', { gasLimit: 100_000n }, 'Zone withdrawal not found'],
    [
      'calldata recipient differs from event',
      { eventTo: merchant, to: other },
      'Zone withdrawal not found',
    ],
  ] as const)('rejects a mismatched %s', async (_, overrides, error) => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo, ...overrides }]
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow(error)
  })

  test('rejects a reverted settlement transaction', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({
      status: 'reverted',
      withdrawals: () => fixture,
    })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow('Transaction reverted')
  })

  test('rejects a zone the challenge does not accept', async () => {
    const { challenge, credential, rpcMethods, server } = setup()
    const { challenge: c } = await challenge()
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash, zoneId: 4 })),
    ).rejects.toThrow('Zone is not accepted for this challenge')
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('rejects zone credentials for split payments', async () => {
    const { challenge, credential, server } = setup()
    const { challenge: c } = await challenge({
      splits: [{ amount: '0.1', recipient: other }],
    })
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow('Zone credentials do not support split payments')
  })
})
