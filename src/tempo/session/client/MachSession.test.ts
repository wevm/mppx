import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { afterEach, describe, expect, test } from 'vp/test'

import { serialize as serializeChallenge, type Challenge } from '../../../Challenge.js'
import * as Fetch from '../../../client/internal/Fetch.js'
import * as Mppx from '../../../client/Mppx.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import type * as z from '../../../zod.js'
import * as defaults from '../../internal/defaults.js'
import type * as Methods from '../../Methods.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import type * as Types from '../precompile/Protocol.js'
import { createChannelStore, persistChannel } from './ChannelStore.js'
import { session } from './Session.js'

const mocks = vi.hoisted(() => ({ getMetadata: vi.fn(), getRemainingLimit: vi.fn() }))

vi.mock('viem/tempo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/tempo')>()
  return {
    ...actual,
    Actions: {
      ...actual.Actions,
      accessKey: {
        ...actual.Actions.accessKey,
        getMetadata: mocks.getMetadata,
        getRemainingLimit: mocks.getRemainingLimit,
      },
    },
  }
})

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const chainId = defaults.chainId.testnet
const mach = defaults.machineToken[chainId].token as Address
const stablecoin = defaults.tokens.pathUsd as Address
const usdc = defaults.tokens.usdc as Address
const payee = '0x0000000000000000000000000000000000000002' as Address

/** A test client whose MACH balance read returns \`machBalance\`, or fails when it is an Error. */
function makeClient(
  machBalance: bigint | Error | ((holder: Address) => bigint),
  channelState: { settled: bigint; deposit: bigint; closeRequestedAt: number } = {
    settled: 0n,
    deposit: 1_000n,
    closeRequestedAt: 0,
  },
) {
  return createClient({
    account,
    chain: { id: chainId } as never,
    transport: custom(
      {
        async request(args) {
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          if (args.method === 'eth_getTransactionCount') return '0x0'
          if (args.method === 'eth_estimateGas') return '0x5208'
          if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
          if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
          if (args.method === 'eth_call') {
            const [call] = args.params as [{ to: Address; data: `0x${string}` }]
            if (call.to.toLowerCase() === mach.toLowerCase()) {
              const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
              if (decoded.functionName !== 'balanceOf') throw new Error('unexpected MACH call')
              if (machBalance instanceof Error) throw machBalance
              const result =
                typeof machBalance === 'function' ? machBalance(decoded.args[0]) : machBalance
              return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result })
            }
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'getChannelState',
              result: channelState,
            })
          }
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      },
      { retryCount: 0 },
    ),
  })
}

type SessionChallenge = Challenge<
  z.output<typeof Methods.session.schema.request>,
  typeof Methods.session.intent,
  typeof Methods.session.name
>

function offer(currency: Address, methodDetails: Record<string, unknown> = {}): SessionChallenge {
  return {
    id: `session-${currency}`,
    realm: 'example.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '100',
      currency,
      recipient: payee,
      suggestedDeposit: '1000',
      unitType: 'request',
      methodDetails: {
        chainId,
        escrowContract: tip20ChannelEscrow,
        sessionProtocol: Constants.SessionProtocols.v2,
        ...methodDetails,
      },
    },
  }
}

function paymentRequired(offers: readonly SessionChallenge[]) {
  return new Response(null, {
    status: 402,
    headers: {
      [Constants.Headers.wwwAuthenticate]: offers.map((o) => serializeChallenge(o)).join(', '),
    },
  })
}

/** Pays one request against a server advertising \`offers\` and returns the credential it sent. */
async function pay(
  offers: readonly SessionChallenge[],
  options: {
    context?: Record<string, unknown> | undefined
    machBalance?: bigint | Error | ((holder: Address) => bigint)
    parameters?: Partial<session.Parameters>
  } = {},
) {
  const client = makeClient(options.machBalance ?? 1_000n)
  const credentials: Credential.Credential<Types.SessionCredentialPayload>[] = []
  const fetch = Fetch.from({
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization')
      if (!authorization) return paymentRequired(offers)
      credentials.push(Credential.deserialize<Types.SessionCredentialPayload>(authorization))
      return new Response('paid')
    },
    methods: [session({ account, decimals: 0, getClient: () => client, ...options.parameters })],
  })
  await fetch('https://example.com/resource', { context: options.context } as RequestInit)
  expect(credentials).toHaveLength(1)
  return credentials[0]!
}

function openTransaction(payload: Types.SessionCredentialPayload) {
  if (payload.action !== 'open') throw new Error('expected open payload')
  return Transaction.deserialize(
    payload.transaction as Transaction.TransactionSerializedTempo,
  ) as Transaction.TransactionSerializableTempo
}

function feeTokenOf(transaction: Transaction.TransactionSerializableTempo) {
  return String(transaction.feeToken).toLowerCase()
}

afterEach(() => {
  mocks.getMetadata.mockReset()
  mocks.getRemainingLimit.mockReset()
})

describe('MACH session preference', () => {
  test.each([false, true])(
    'opens a MACH session when MACH covers the deposit (MACH offered first: %s)',
    async (machFirst) => {
      const offers = machFirst ? [offer(mach), offer(stablecoin)] : [offer(stablecoin), offer(mach)]
      const credential = await pay(offers)

      expect(credential.challenge.request.currency).toBe(mach)
      expect(credential.payload).toMatchObject({
        action: 'open',
        descriptor: { token: mach, payee },
      })
      const transaction = openTransaction(credential.payload)
      const [call] = transaction.calls as readonly { data: `0x${string}` }[]
      expect(decodeFunctionData({ abi: escrowAbi, data: call!.data }).args).toMatchObject([
        payee,
        expect.any(String),
        mach,
        1_000n,
        expect.any(String),
        account.address,
      ])
      // MACH cannot pay fees: the open pays them in the chain's default stablecoin.
      expect(feeTokenOf(transaction)).toBe(stablecoin.toLowerCase())
    },
  )

  test.each([false, true])(
    'falls back to a stablecoin session when MACH cannot cover the deposit (MACH offered first: %s)',
    async (machFirst) => {
      const offers = machFirst ? [offer(mach), offer(stablecoin)] : [offer(stablecoin), offer(mach)]
      const credential = await pay(offers, { machBalance: 999n })

      expect(credential.challenge.request.currency).toBe(stablecoin)
      expect(feeTokenOf(openTransaction(credential.payload))).toBe(stablecoin.toLowerCase())
    },
  )

  test('falls back to a stablecoin session when the MACH balance cannot be read', async () => {
    const credential = await pay([offer(mach), offer(stablecoin)], {
      machBalance: new Error('RPC unavailable'),
    })
    expect(credential.challenge.request.currency).toBe(stablecoin)
  })

  test('sizes the MACH deposit check with maxDeposit', async () => {
    const credential = await pay([offer(stablecoin), offer(mach)], {
      machBalance: 500n,
      parameters: { maxDeposit: '500' },
    })
    expect(credential.challenge.request.currency).toBe(mach)
  })

  test('keeps a currency pin strict', async () => {
    const credential = await pay([offer(mach), offer(stablecoin)], {
      parameters: { currencies: [stablecoin] },
    })
    expect(credential.challenge.request.currency).toBe(stablecoin)
  })

  test('still pays the only offer in MACH when MACH is short', async () => {
    const credential = await pay([offer(mach)], { machBalance: 5_000n })
    expect(credential.challenge.request.currency).toBe(mach)
  })

  test('falls back when an access key may not spend the MACH deposit', async () => {
    const accessKeyAddress = '0x0000000000000000000000000000000000000009' as Address
    mocks.getMetadata.mockResolvedValue({
      address: accessKeyAddress,
      keyType: 'secp256k1',
      expiry: 0n,
      spendPolicy: 'limited',
      isRevoked: false,
    })
    mocks.getRemainingLimit.mockResolvedValue({
      remaining: 999n,
      periodEnd: undefined,
    })
    const credential = await pay([offer(mach), offer(stablecoin)], {
      parameters: { account: Object.assign({}, account, { accessKeyAddress }) },
    })
    expect(credential.challenge.request.currency).toBe(stablecoin)
    expect(mocks.getRemainingLimit.mock.calls[0]![1]).toMatchObject({
      accessKey: accessKeyAddress,
      token: mach,
    })
  })

  test('falls back when a stored MACH channel would exceed maxDeposit', async () => {
    const channelStore = createChannelStore()
    const descriptor = {
      authorizedSigner: account.address,
      expiringNonceHash: `0x2222222222222222222222222222222222222222222222222222222222222222`,
      operator: '0x0000000000000000000000000000000000000000',
      payee,
      payer: account.address,
      salt: `0x1111111111111111111111111111111111111111111111111111111111111111`,
      token: mach,
    } as const
    const escrow = tip20ChannelEscrow
    await persistChannel(channelStore, {
      chainId,
      channelId: Channel.computeId({ ...descriptor, chainId, escrow }),
      cumulativeAmount: 500n,
      deposit: 1_000n,
      descriptor,
      escrow,
      opened: true,
      origin: 'https://example.com',
    })
    const credential = await pay([offer(mach), offer(stablecoin)], {
      parameters: { channelStore, maxDeposit: '500' },
    })
    expect(credential.challenge.request.currency).toBe(stablecoin)
  })

  test.each([
    { name: 'open', state: { settled: 0n, deposit: 1_000n, closeRequestedAt: 0 }, pick: mach },
    { name: 'closed', state: { settled: 0n, deposit: 0n, closeRequestedAt: 0 }, pick: stablecoin },
    {
      name: 'close-requested',
      state: { settled: 0n, deposit: 1_000n, closeRequestedAt: 1 },
      pick: stablecoin,
    },
    {
      name: 'exhausted',
      state: { settled: 0n, deposit: 50n, closeRequestedAt: 0 },
      pick: stablecoin,
    },
  ])('prefers a snapshot MACH channel only when it is usable ($name)', async ({ state, pick }) => {
    const descriptor = {
      authorizedSigner: account.address,
      expiringNonceHash: `0x2222222222222222222222222222222222222222222222222222222222222222`,
      operator: '0x0000000000000000000000000000000000000000',
      payee,
      payer: account.address,
      salt: `0x1111111111111111111111111111111111111111111111111111111111111111`,
      token: mach,
    } as const
    const escrow = tip20ChannelEscrow
    const snapshot = {
      acceptedCumulative: '0',
      chainId,
      channelId: Channel.computeId({ ...descriptor, chainId, escrow }),
      deposit: '1000',
      descriptor,
      escrow,
      requiredCumulative: '100',
      settled: '0',
      spent: '0',
    }
    const client = makeClient(0n, state)
    const mppx = Mppx.create({
      methods: [session({ account, decimals: 0, getClient: () => client })],
      polyfill: false,
    })
    const prepared = await mppx.preparePayment(
      paymentRequired([offer(stablecoin), offer(mach, { sessionSnapshot: snapshot })]),
    )
    expect(prepared.challenge.request.currency).toBe(pick)
  })

  test("checks the caller's account override", async () => {
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const balanceOf = (holder: Address) =>
      holder.toLowerCase() === account.address.toLowerCase() ? 1_000n : 0n
    const offers = [offer(stablecoin), offer(mach)]
    const overridden = await pay(offers, { context: { account: other }, machBalance: balanceOf })
    expect(overridden.challenge.request.currency).toBe(stablecoin)
    const funded = await pay(offers, {
      context: { account },
      machBalance: balanceOf,
      parameters: { account: other },
    })
    expect(funded.challenge.request.currency).toBe(mach)
  })

  test('prefers a fundable MACH offer behind an unfundable one', async () => {
    const large = offer(mach)
    const unfundable = {
      ...large,
      id: 'session-mach-large',
      request: { ...large.request, suggestedDeposit: '5000' },
    }
    const credential = await pay([unfundable, offer(stablecoin), offer(mach)])
    expect(credential.challenge.request.currency).toBe(mach)
    expect(credential.challenge.request.suggestedDeposit).toBe('1000')
  })

  test('prefers MACH in preparePayment', async () => {
    const client = makeClient(1_000n)
    const mppx = Mppx.create({
      methods: [session({ account, decimals: 0, getClient: () => client })],
      polyfill: false,
    })
    const prepared = await mppx.preparePayment(paymentRequired([offer(stablecoin), offer(mach)]))
    expect(prepared.challenge.request.currency).toBe(mach)
  })
})

describe('MACH session fees', () => {
  test('uses the advertised fee token', async () => {
    const credential = await pay([offer(mach, { feeToken: usdc })])
    expect(feeTokenOf(openTransaction(credential.payload))).toBe(usdc.toLowerCase())
  })

  test('uses machFeeToken when none is advertised', async () => {
    const credential = await pay([offer(mach)], { parameters: { machFeeToken: usdc } })
    expect(feeTokenOf(openTransaction(credential.payload))).toBe(usdc.toLowerCase())
  })

  test('pays MACH top-ups in a separate fee token', async () => {
    const client = makeClient(1_000n)
    const method = session({ account, decimals: 0, getClient: () => client })
    const payload = Credential.deserialize<Types.SessionCredentialPayload>(
      await method.createCredential({
        challenge: offer(mach),
        context: {
          action: 'topUp',
          additionalDepositRaw: '100',
          descriptor: {
            authorizedSigner: account.address,
            expiringNonceHash: `0x${'22'.repeat(32)}`,
            operator: '0x0000000000000000000000000000000000000000',
            payee,
            payer: account.address,
            salt: `0x${'11'.repeat(32)}`,
            token: mach,
          },
        },
      }),
    ).payload
    if (payload.action !== 'topUp') throw new Error('expected top-up payload')
    const transaction = Transaction.deserialize(
      payload.transaction as Transaction.TransactionSerializedTempo,
    ) as Transaction.TransactionSerializableTempo
    expect(feeTokenOf(transaction)).toBe(stablecoin.toLowerCase())
  })

  test('rejects MACH as a fee token', async () => {
    const client = makeClient(1_000n)
    await expect(
      session({ account, decimals: 0, getClient: () => client }).createCredential({
        challenge: offer(stablecoin, { feeToken: mach }),
        context: {},
      }),
    ).rejects.toThrow('MACH cannot pay transaction fees')
    await expect(
      session({
        account,
        decimals: 0,
        getClient: () => client,
        machFeeToken: mach,
      }).createCredential({ challenge: offer(mach), context: {} }),
    ).rejects.toThrow('MACH cannot pay transaction fees')
  })

  test('keeps the channel token as fee token for stablecoin sessions', async () => {
    const credential = await pay([offer(usdc)])
    expect(feeTokenOf(openTransaction(credential.payload))).toBe(usdc.toLowerCase())
  })
})
