import { Challenge, Credential, Errors } from 'mppx'
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
  callbackSuccess?: boolean
  eventAddress?: Address
  inCalldata?: boolean
}

function setup(
  options: {
    withdrawals?: () => WithdrawalFixture[]
    status?: 'success' | 'reverted'
    zones?: number[] | true
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
      args: { to: w.to ?? merchant, senderTag: w.senderTag },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint128' }, { type: 'bool' }],
      [w.token ?? currency, w.amount ?? 1_000_000n, w.callbackSuccess ?? true],
    ),
  })

  const client = createClient({
    chain: tempoModerato,
    transport: custom({
      async request({ method }) {
        rpcMethods.push(method)
        if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
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
          hash: payload.hash ?? settlementHash,
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

  test('rejects a credential without a settlement hash', async () => {
    const { challenge, rpcMethods, server } = setup()
    const { challenge: c } = await challenge()
    const hashless = Credential.serialize(
      Credential.from({
        challenge: c,
        payload: { senderTag: tagA, type: 'zone', zoneId } as never,
      }),
    )
    await expect(server.verifyCredential(hashless)).rejects.toThrow()
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
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
    ['recipient', { to: other }, 'Zone withdrawal not found'],
    ['amount', { amount: 999_999n }, 'Zone withdrawal not found'],
    ['currency', { token: otherCurrency }, 'Zone withdrawal not found'],
    ['bounced withdrawal', { callbackSuccess: false }, 'Zone withdrawal bounced'],
    ['event from another portal', { eventAddress: Zone.portalAddress(4) }, 'not settled'],
    ['withdrawal missing from calldata', { inCalldata: false }, 'Zone withdrawal not found'],
    ['callback withdrawal', { gasLimit: 100_000n }, 'Zone withdrawal not found'],
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
    const error = await server
      .verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash }))
      .catch((e) => e)
    expect(error).toBeInstanceOf(Errors.PaymentError)
    expect(String(error)).toContain('settlement transaction reverted')
  })

  test('rejects a zone the challenge does not accept', async () => {
    const { challenge, credential, rpcMethods, server } = setup()
    const { challenge: c } = await challenge()
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash, zoneId: 4 })),
    ).rejects.toThrow('Zone is not accepted for this challenge')
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('accepts a withdrawal from any Zone when zones is true', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture, zones: true })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    expect(c.request.methodDetails).toMatchObject({ zones: true })
    const receipt = await server.verifyCredential(
      credential(c, { senderTag: tagA, hash: settlementHash }),
    )
    expect(receipt).toMatchObject({ method: 'tempo', status: 'success' })
  })

  test('checks the portal of the Zone the credential names when zones is true', async () => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture, zones: true })
    const { challenge: c, memo } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
    // The settlement came from Zone 3's portal, not Zone 4's.
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash, zoneId: 4 })),
    ).rejects.toThrow('Zone withdrawal not settled')
  })

  test.each([0, -1, 1.5, 2 ** 32])('rejects Zone ID %s', async (zoneId) => {
    const { challenge, credential, rpcMethods, server } = setup({ zones: true })
    const { challenge: c } = await challenge()
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash, zoneId })),
    ).rejects.toThrow()
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('rejects zone credentials when the challenge only accepts pull payments', async () => {
    const { challenge, credential, rpcMethods, server } = setup()
    const { challenge: c } = await challenge({ supportedModes: ['pull'] })
    await expect(
      server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow('Zone credentials are not supported for this challenge')
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
