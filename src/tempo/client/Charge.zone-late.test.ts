import { Challenge, Credential } from 'mppx'
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
  test('is returned again only for its own challenge, and a new challenge withdraws again', async () => {
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

    // A new challenge with the same terms is a new payment.
    const second = await challenge()
    const credential = await method.createCredential(parameters(second))
    expect(Credential.deserialize(credential).challenge.id).toBe(second.id)
    expect(mocks.sent).toHaveLength(2)
  })
})
