import { Challenge, Credential, Errors } from 'mppx'
import { tempo as tempo_client } from 'mppx/client'
import { Mppx, tempo } from 'mppx/server'
import { createClient, custom, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { afterEach, describe, expect, test } from 'vp/test'

import * as MethodResponse from '../../client/internal/MethodResponse.js'

const mocks = vi.hoisted(() => ({
  onSettle: undefined as (() => void) | undefined,
  sent: [] as string[],
}))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  prepareTransactionRequest: vi.fn(async () => ({})),
  sendRawTransactionSync: vi.fn(async () => {
    const transactionHash = `0x${(mocks.sent.length + 1).toString(16).padStart(64, '0')}`
    mocks.sent.push(transactionHash)
    return { blockNumber: 1n, logs: [], status: 'success', transactionHash }
  }),
  signTransaction: vi.fn(async () => `0x76${'00'.repeat(32)}${mocks.sent.length}`),
}))

vi.mock('viem/tempo', async (importOriginal) => {
  const original = await importOriginal<typeof import('viem/tempo')>()
  return {
    ...original,
    Actions: {
      ...original.Actions,
      zone: { ...original.Actions.zone, getWithdrawalFee: vi.fn(async () => 0n) },
    },
  }
})

vi.mock('../internal/zone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../internal/zone.js')>()),
  senderTagCandidates: vi.fn(
    async (_: unknown, { transactionHash }: { transactionHash: string }) => [transactionHash],
  ),
  waitForSettledWithdrawal: vi.fn(async (_: unknown, { senderTags }: { senderTags: string[] }) => {
    mocks.onSettle?.()
    return { hash: senderTags[0], senderTag: senderTags[0] }
  }),
}))

const merchant = '0x2222222222222222222222222222222222222222'
const currency = '0x20c0000000000000000000000000000000000001'
const origin = 'https://example.com'
const payer = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)

const l1 = createClient({
  chain: tempoModerato,
  transport: custom({
    async request({ method }) {
      if (method === 'eth_chainId') return `0x${tempoModerato.id.toString(16)}`
      throw new Error(`l1: ${method}`)
    },
  }),
})

const zone = createClient({
  account: payer,
  chain: defineChain({ ...tempoModerato, id: 1_424_310_003, name: 'Zone' }),
  transport: custom({
    async request({ method }) {
      throw new Error(`zone: ${method}`)
    },
  }),
})

async function challenge() {
  const server = Mppx.create({
    realm: 'api.example.com',
    secretKey: 'test-secret-key-test-secret-key-32',
    methods: [
      tempo.charge({ account: merchant, currency, getClient: () => l1, testnet: true, zones: [3] }),
    ],
  })
  const result = await server.charge({ amount: '1', decimals: 6 })(new Request(origin))
  if (result.status !== 402) throw new Error('Expected challenge')
  return Challenge.fromResponse(result.challenge)
}

function parameters(c: Challenge.Challenge) {
  const parameters = { challenge: c as never, context: {} }
  MethodResponse.attachOrigin(parameters, origin)
  return parameters
}

afterEach(() => {
  mocks.onSettle = undefined
  mocks.sent.length = 0
  vi.useRealTimers()
})

describe('tempo.charge client: a Zone credential returned after its challenge expired', () => {
  test('is returned again only for its own challenge, and blocks its terms until its window ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const method = tempo_client.charge({
      getClient: () => l1,
      zone: { client: zone, settlementTimeoutMs: 1_000 },
    })
    const first = await challenge()
    // The withdrawal settles only after the first challenge expired.
    mocks.onSettle = () => vi.setSystemTime(new Date(first.expires!).getTime() + 1_000)
    const late = await method.createCredential(parameters(first))
    mocks.onSettle = undefined
    expect(Credential.deserialize(late).challenge.id).toBe(first.id)
    expect(mocks.sent).toHaveLength(1)

    // A retry of the first challenge gets its credential without withdrawing again.
    expect(await method.createCredential(parameters(first))).toBe(late)
    expect(mocks.sent).toHaveLength(1)

    // The server may have redeemed or refused the late credential, so a new challenge with the
    // same terms neither reuses it nor pays again while it can still be redeemed.
    const second = await challenge()
    const error = await method.createCredential(parameters(second)).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Errors.ZoneSettlementPendingError)
    expect(String(error)).toContain('has not settled on Tempo yet')
    // It names the challenge the withdrawal paid and the withdrawal's sender tag.
    const pendingError = error as Errors.ZoneSettlementPendingError
    expect(pendingError.challengeId).toBe(first.id)
    expect(pendingError.senderTags).toEqual([
      (Credential.deserialize(late).payload as { senderTag: string }).senderTag,
    ])
    expect(mocks.sent).toHaveLength(1)

    // Once no server can redeem it, a new challenge is a new payment.
    vi.setSystemTime(new Date(first.expires!).getTime() + 5 * 60_000 + 1_000)
    const third = await challenge()
    const credential = await method.createCredential(parameters(third))
    expect(Credential.deserialize(credential).challenge.id).toBe(third.id)
    expect(mocks.sent).toHaveLength(2)

    // A retry of the first challenge, no longer tracked, is refused without paying again.
    await expect(method.createCredential(parameters(first))).rejects.toThrow()
    expect(mocks.sent).toHaveLength(2)
  })
})
