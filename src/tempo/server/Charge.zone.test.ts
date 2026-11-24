import { Challenge, Credential, Errors, Store } from 'mppx'
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
import { describe, expect, test, vi } from 'vp/test'

import * as ChallengeMeta from '../../internal/challengeMeta.js'
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
    /** The currency the server's method charges in. */
    currency?: Address
    withdrawals?: () => WithdrawalFixture[]
    /** When the settlement transaction's block was produced, in Unix milliseconds. */
    settledAt?: number
    /** Whether the receipt also carries the portal's payout transfer for each withdrawal. */
    payoutTransfers?: boolean
    status?: 'success' | 'reverted'
    store?: Store.AtomicStore
    zoneCredentialGraceMs?: number
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

  // The TIP-20 transfer the portal makes to pay a withdrawal out, carrying its memo.
  const payoutLog = (w: WithdrawalFixture, index: number) => ({
    ...processedLog(w, index),
    address: w.token ?? currency,
    topics: encodeEventTopics({
      abi: Abis.tip20,
      eventName: 'TransferWithMemo',
      args: { from: portal, to: w.to ?? merchant, memo: w.memo },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [w.amount ?? 1_000_000n]),
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
            logs: withdrawals().flatMap((w, index) =>
              options.payoutTransfers
                ? [processedLog(w, 2 * index), payoutLog(w, 2 * index + 1)]
                : [processedLog(w, index)],
            ),
          }
        if (method === 'eth_getBlockByNumber')
          return {
            hash: settlementHash,
            number: '0x10',
            timestamp: `0x${Math.floor((options.settledAt ?? Date.now()) / 1000).toString(16)}`,
            transactions: [],
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
        currency: options.currency ?? currency,
        getClient: () => client,
        ...(options.store && { store: options.store as never }),
        testnet: true,
        zoneCredentialGraceMs: options.zoneCredentialGraceMs,
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

  return { challenge, credential, rpc: client, rpcMethods, server }
}

const tagA = `0x${'a1'.repeat(32)}` as const
const tagB = `0x${'b2'.repeat(32)}` as const

describe('tempo.charge zone credentials', () => {
  describe('a Zone settlement presented as a hash credential', () => {
    function hashCredential(challenge: Challenge.Challenge, source?: string) {
      return Credential.serialize(
        Credential.from({
          challenge,
          payload: { hash: settlementHash, type: 'hash' },
          ...(source ? { source } : {}),
        }),
      )
    }
    const portalSource = `did:pkh:eip155:${tempoModerato.id}:${portal}`

    test('is refused after the zone credential redeemed it', async () => {
      let fixture: WithdrawalFixture[] = []
      const { challenge, credential, server } = setup({
        payoutTransfers: true,
        withdrawals: () => fixture,
      })
      const { challenge: c, memo } = await challenge()
      fixture = [{ senderTag: tagA, memo }]
      await expect(
        server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
      ).resolves.toMatchObject({ reference: settlementHash, status: 'success' })
      await expect(server.verifyCredential(hashCredential(c, portalSource))).rejects.toThrow(
        'no matching transfer found',
      )
    })

    test.each([
      ['naming the portal as its source', portalSource],
      ['without a source', undefined],
    ])('is refused %s', async (_, source) => {
      let fixture: WithdrawalFixture[] = []
      const { challenge, credential, server } = setup({
        payoutTransfers: true,
        withdrawals: () => fixture,
      })
      const { challenge: c, memo } = await challenge()
      fixture = [{ senderTag: tagA, memo }]
      await expect(server.verifyCredential(hashCredential(c, source))).rejects.toThrow(
        'no matching transfer found',
      )
      // The settlement still pays once, through its zone credential.
      await expect(
        server.verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash })),
      ).resolves.toMatchObject({ reference: settlementHash, status: 'success' })
    })

    test('is refused by a validateSender that accepts any sender', async () => {
      let fixture: WithdrawalFixture[] = []
      const client = setup({ payoutTransfers: true, withdrawals: () => fixture })
      const { challenge: c, memo } = await client.challenge()
      fixture = [{ senderTag: tagA, memo }]
      const server = Mppx.create({
        realm,
        secretKey: 'test-secret-key-test-secret-key-32',
        methods: [
          tempo.charge({
            account: merchant,
            currency,
            getClient: () => client.rpc,
            testnet: true,
            validateSender: () => true,
            zones: [zoneId],
          }),
        ],
      })
      await expect(server.verifyCredential(hashCredential(c, portalSource))).rejects.toThrow(
        'no matching transfer found',
      )
    })
  })

  test('accepts a withdrawal settled before the challenge expired, presented after', async () => {
    let fixture: WithdrawalFixture[] = []
    const expiresAt = Date.now() - 1_000
    const { challenge, credential, server } = setup({
      settledAt: expiresAt - 30_000,
      withdrawals: () => fixture,
      zoneCredentialGraceMs: 60_000,
    })
    const { challenge: c, memo } = await challenge({ expires: new Date(expiresAt).toISOString() })
    fixture = [{ senderTag: tagA, memo }]
    const serialized = credential(c, { senderTag: tagA, hash: settlementHash })
    const receipt = await server.verifyCredential(serialized)
    expect(receipt).toMatchObject({ method: 'tempo', reference: settlementHash, status: 'success' })
    await expect(server.verifyCredential(serialized)).rejects.toThrow(
      'Zone withdrawal has already been used',
    )
  })

  test('keeps a redeemed withdrawal from a server that grants more grace on the same store', async () => {
    let fixture: WithdrawalFixture[] = []
    const store = Store.memory()
    const expiresAt = Date.now() + 60_000
    const options = { settledAt: Date.now(), store, withdrawals: () => fixture }
    const strict = setup({ ...options, zoneCredentialGraceMs: 1_000 })
    const { challenge: c, memo } = await strict.challenge({
      expires: new Date(expiresAt).toISOString(),
    })
    fixture = [{ senderTag: tagA, memo }]
    const serialized = strict.credential(c, { senderTag: tagA, hash: settlementHash })
    await expect(strict.server.verifyCredential(serialized)).resolves.toMatchObject({
      status: 'success',
    })
    const lenient = setup({ ...options, zoneCredentialGraceMs: Zone.redemptionGraceMs })
    vi.useFakeTimers({ now: expiresAt + Zone.redemptionGraceMs - 1_000, toFake: ['Date'] })
    try {
      await expect(lenient.server.verifyCredential(serialized)).rejects.toThrow(
        'Zone withdrawal has already been used',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('marks only challenges issued with the grace on', async () => {
    const { challenge: strict } = await setup().challenge()
    const { challenge: lenient } = await setup({ zoneCredentialGraceMs: 60_000 }).challenge()
    expect(ChallengeMeta.hasExpiryGrace(strict)).toBe(false)
    expect(ChallengeMeta.hasExpiryGrace(lenient)).toBe(true)
  })

  test('gives no grace to a challenge issued without it', async () => {
    let fixture: WithdrawalFixture[] = []
    const expiresAt = Date.now() + 60_000
    const options = { settledAt: Date.now(), withdrawals: () => fixture }
    // Issued by a server without the grace, as an earlier release issues every challenge: its
    // replay claim may already have ended at the expiry.
    const { challenge: c, memo } = await setup(options).challenge({
      expires: new Date(expiresAt).toISOString(),
    })
    fixture = [{ senderTag: tagA, memo }]
    const lenient = setup({ ...options, zoneCredentialGraceMs: 60_000 })
    vi.useFakeTimers({ now: expiresAt + 1_000, toFake: ['Date'] })
    try {
      const error = await lenient.server
        .verifyCredential(lenient.credential(c, { senderTag: tagA, hash: settlementHash }))
        .catch((e) => e)
      expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
    } finally {
      vi.useRealTimers()
    }
    expect(lenient.rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('refuses a challenge that adds the grace marker itself', async () => {
    const expiresAt = Date.now() - 1_000
    const { credential, rpcMethods, server } = setup({
      settledAt: expiresAt - 30_000,
      zoneCredentialGraceMs: 60_000,
    })
    const { challenge: c } = await setup().challenge({
      expires: new Date(expiresAt).toISOString(),
    })
    // The challenge ID binds `opaque`, so a client can't add the marker to a challenge.
    const forged = Challenge.from({
      ...c,
      meta: ChallengeMeta.withExpiryGrace(c.meta, true),
      opaque: undefined,
    })
    expect(ChallengeMeta.hasExpiryGrace(forged)).toBe(true)
    await expect(
      server.verifyCredential(credential(forged, { senderTag: tagA, hash: settlementHash })),
    ).rejects.toThrow()
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('takes the expiry grace from the method that matches the challenge', async () => {
    let fixture: WithdrawalFixture[] = []
    const expiresAt = Date.now() - 1_000
    const lenient = setup({
      currency: otherCurrency,
      settledAt: expiresAt - 30_000,
      withdrawals: () => fixture,
      zoneCredentialGraceMs: 60_000,
    })
    const { challenge: c, memo } = await lenient.challenge({
      expires: new Date(expiresAt).toISOString(),
    })
    fixture = [{ memo, senderTag: tagA, token: otherCurrency }]
    const shared = {
      account: merchant as Address,
      getClient: () => lenient.rpc,
      testnet: true,
      zones: [zoneId],
    }
    const server = Mppx.create({
      realm,
      secretKey: 'test-secret-key-test-secret-key-32',
      methods: [
        tempo.charge({ ...shared, currency }),
        tempo.charge({ ...shared, currency: otherCurrency, zoneCredentialGraceMs: 60_000 }),
      ],
    })
    await expect(
      server.verifyCredential(lenient.credential(c, { senderTag: tagA, hash: settlementHash })),
    ).resolves.toMatchObject({ reference: settlementHash, status: 'success' })
  })

  test('rejects a withdrawal settled after the challenge expired', async () => {
    let fixture: WithdrawalFixture[] = []
    const expiresAt = Date.now() - 10_000
    const { challenge, credential, server } = setup({
      settledAt: expiresAt + 5_000,
      withdrawals: () => fixture,
      zoneCredentialGraceMs: 60_000,
    })
    const { challenge: c, memo } = await challenge({ expires: new Date(expiresAt).toISOString() })
    fixture = [{ senderTag: tagA, memo }]
    const error = await server
      .verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash }))
      .catch((e) => e)
    expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
  })

  test('accepts no zone credential after its challenge expired by default', async () => {
    const { challenge, credential, rpcMethods, server } = setup({ settledAt: Date.now() - 60_000 })
    const { challenge: c } = await challenge({
      expires: new Date(Date.now() - 1_000).toISOString(),
    })
    const error = await server
      .verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash }))
      .catch((e) => e)
    expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test.each([-1, Number.NaN, Zone.redemptionGraceMs + 1])(
    'rejects zoneCredentialGraceMs %s',
    (zoneCredentialGraceMs) => {
      expect(() => setup({ zoneCredentialGraceMs })).toThrow('zoneCredentialGraceMs')
    },
  )

  test('rejects a zone credential presented after the redemption grace period', async () => {
    const { challenge, credential, rpcMethods, server } = setup({ zoneCredentialGraceMs: 60_000 })
    const expires = new Date(Date.now() - 61_000).toISOString()
    const { challenge: c } = await challenge({ expires })
    const error = await server
      .verifyCredential(credential(c, { senderTag: tagA, hash: settlementHash }))
      .catch((e) => e)
    expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

  test('gives no grace to other credentials of an expired challenge', async () => {
    const { challenge, rpcMethods, server } = setup({ zoneCredentialGraceMs: 60_000 })
    const { challenge: c } = await challenge({
      expires: new Date(Date.now() - 1_000).toISOString(),
    })
    const hash = Credential.serialize(
      Credential.from({ challenge: c, payload: { hash: settlementHash, type: 'hash' } }),
    )
    const error = await server.verifyCredential(hash).catch((e) => e)
    expect(error).toBeInstanceOf(Errors.PaymentExpiredError)
    expect(rpcMethods).not.toContain('eth_getTransactionReceipt')
  })

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

  test.each([
    ['no memo', zeroHash],
    ['a memo not in attribution format', `0x${'ab'.repeat(32)}` as const],
  ])('rejects a withdrawal with %s', async (_, memo) => {
    let fixture: WithdrawalFixture[] = []
    const { challenge, credential, server } = setup({ withdrawals: () => fixture })
    const { challenge: c } = await challenge()
    fixture = [{ senderTag: tagA, memo }]
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

  test.each([0, -1, 1.5, 2 ** 32, 421_700_005])('rejects Zone ID %s', async (zoneId) => {
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
