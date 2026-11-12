import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import type { Challenge } from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import type * as z from '../../../zod.js'
import * as AutoSwap from '../../internal/auto-swap.js'
import * as defaults from '../../internal/defaults.js'
import type * as Methods from '../../Methods.js'
import type * as Types from '../precompile/Protocol.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import { channelKey, createChannelStore, entryKey } from './ChannelStore.js'
import { session } from './Session.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const chainId = 42431
const mach = defaults.machineToken[chainId].token as Address
const currency = '0x20c0000000000000000000000000000000000001' as Address
const payee = '0x0000000000000000000000000000000000000002' as Address

function createTestClient(parameters: {
  machBalance: bigint
  calls?: { to?: Address | undefined }[]
  stablecoinBalance?: bigint
}) {
  const { calls = [], machBalance, stablecoinBalance = 1_000_000n } = parameters
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
            const { data, to } = (args.params as [{ data: Hex; to?: Address }])[0]
            calls.push({ to })
            const balanceOf = (() => {
              try {
                return decodeFunctionData({ abi: erc20Abi, data }).functionName === 'balanceOf'
              } catch {
                return false
              }
            })()
            if (balanceOf)
              return encodeFunctionResult({
                abi: erc20Abi,
                functionName: 'balanceOf',
                result: to?.toLowerCase() === mach.toLowerCase() ? machBalance : stablecoinBalance,
              })
            return `0x${'00'.repeat(32)}`
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

function makeChallenge(
  methodDetails: Record<string, unknown> = { machTokenAccepted: true },
): SessionChallenge {
  return {
    id: 'challenge-id',
    realm: 'example.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '100',
      currency,
      recipient: payee,
      unitType: 'request',
      methodDetails: {
        chainId,
        escrowContract: tip20ChannelEscrow,
        sessionProtocol: Constants.SessionProtocols.v2,
        ...methodDetails,
      } as SessionChallenge['request']['methodDetails'],
    },
  }
}

function deserialize(credential: string) {
  return Credential.deserialize(credential).payload as Types.SessionCredentialPayload
}

function openTransaction(payload: Types.SessionCredentialPayload) {
  if (payload.action !== 'open') throw new Error(`expected open, got ${payload.action}`)
  return Transaction.deserialize(
    payload.transaction as Transaction.TransactionSerializedTempo,
  ) as Transaction.TransactionSerializableTempo
}

function key(token: Address) {
  return channelKey({ chainId, escrow: tip20ChannelEscrow, payee, token })
}

describe('session machTokenAccepted', () => {
  test('opens the channel in MACH when MACH covers the deposit', async () => {
    const channelStore = createChannelStore()
    const method = session({
      account,
      channelStore,
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })

    const open = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )
    const transaction = openTransaction(open)

    expect(open.descriptor.token).toBe(mach)
    // MACH cannot pay fees, so the payer pays them in the challenge currency.
    expect(String(transaction.feeToken).toLowerCase()).toBe(currency.toLowerCase())
    expect(await channelStore.get(key(mach))).toMatchObject({ channelId: open.channelId })
    expect(await channelStore.get(key(currency))).toBeUndefined()

    const next = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )
    expect(next).toMatchObject({
      action: 'voucher',
      channelId: open.channelId,
      cumulativeAmount: '200',
    })
  })

  test('opens sponsored channels in MACH without MACH as fee token', async () => {
    const method = session({
      account,
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })

    const open = deserialize(
      await method.createCredential({
        challenge: makeChallenge({ feePayer: true, machTokenAccepted: true }),
        context: {},
      }),
    )

    expect(open.descriptor.token).toBe(mach)
    // The fee payer picks the fee token from the server's allowed list, which excludes MACH.
    expect(String(openTransaction(open).feeToken).toLowerCase()).not.toBe(mach.toLowerCase())
  })

  test('opens in MACH only when fees are sponsored or a stablecoin pays them', async () => {
    const open = async (feePayer: boolean) => {
      const method = session({
        account,
        decimals: 0,
        getClient: () => createTestClient({ machBalance: 1_000n, stablecoinBalance: 0n }),
      })
      return deserialize(
        await method.createCredential({
          challenge: makeChallenge({ feePayer, machTokenAccepted: true }),
          context: {},
        }),
      )
    }

    // MACH cannot pay gas, so an unsponsored payer without a stablecoin opens in the currency.
    expect((await open(false)).descriptor.token).toBe(currency)
    expect((await open(true)).descriptor.token).toBe(mach)
  })

  test('opens in the challenge currency when MACH does not cover the deposit', async () => {
    const method = session({
      account,
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 99n }),
    })

    const open = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(open.descriptor.token).toBe(currency)
  })

  test('ignores MACH for challenges without machTokenAccepted', async () => {
    const calls: { to?: Address | undefined }[] = []
    const method = session({
      account,
      decimals: 0,
      getClient: () => createTestClient({ calls, machBalance: 1_000n }),
    })

    const open = deserialize(
      await method.createCredential({ challenge: makeChallenge({}), context: {} }),
    )

    expect(open.descriptor.token).toBe(currency)
    expect(calls).toEqual([])
  })

  test('opens in the challenge currency when the currencies allowlist leaves MACH out', async () => {
    const method = session({
      account,
      currencies: [currency],
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })

    const open = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(open.descriptor.token).toBe(currency)
  })

  test('keeps a single-scope store on the challenge currency when the allowlist leaves MACH out', async () => {
    const open = async (machBalance: bigint) => {
      const backing = createChannelStore()
      const expected = key(currency)
      // Mirrors the CLI's persistent store, which rejects any scope other than its own.
      const assertKey = (k: string) => {
        if (k !== expected) throw new Error(`unexpected payment scope: ${k}`)
      }
      const channelStore: typeof backing = {
        ...backing,
        async get(k) {
          assertKey(k)
          return backing.get(k)
        },
        async set(entry) {
          assertKey(entryKey(entry))
          return backing.set(entry)
        },
        async delete(k) {
          assertKey(k)
          return backing.delete(k)
        },
      }
      const method = session({
        account,
        channelStore,
        currencies: [currency],
        decimals: 0,
        getClient: () => createTestClient({ machBalance }),
      })
      return deserialize(await method.createCredential({ challenge: makeChallenge(), context: {} }))
    }

    expect((await open(1_000n)).descriptor.token).toBe(currency)
    expect((await open(0n)).descriptor.token).toBe(currency)
  })

  test('ignores a MACH channel snapshot when the currencies allowlist leaves MACH out', async () => {
    const method = session({
      account,
      currencies: [currency],
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })
    const sessionSnapshot = {
      acceptedCumulative: '100',
      chainId,
      channelId: `0x${'33'.repeat(32)}`,
      deposit: '1000',
      descriptor: {
        authorizedSigner: account.address,
        expiringNonceHash: `0x${'11'.repeat(32)}`,
        operator: '0x0000000000000000000000000000000000000000',
        payee,
        payer: account.address,
        salt: `0x${'22'.repeat(32)}`,
        token: mach,
      },
      escrow: tip20ChannelEscrow,
      requiredCumulative: '200',
      settled: '0',
      spent: '100',
    }

    const open = deserialize(
      await method.createCredential({
        challenge: makeChallenge({ machTokenAccepted: true, sessionSnapshot }),
        context: {},
      }),
    )

    expect(open.action).toBe('open')
    expect(open.descriptor.token).toBe(currency)
  })

  test('closes an existing MACH channel even when the currencies allowlist leaves MACH out', async () => {
    const method = session({
      account,
      currencies: [currency],
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })
    const descriptor = {
      authorizedSigner: account.address,
      expiringNonceHash: `0x${'11'.repeat(32)}`,
      operator: '0x0000000000000000000000000000000000000000',
      payee,
      payer: account.address,
      salt: `0x${'22'.repeat(32)}`,
      token: mach,
    } as const

    const close = deserialize(
      await method.createCredential({
        challenge: makeChallenge({ machTokenAccepted: true }),
        context: { action: 'close', cumulativeAmountRaw: '100', descriptor },
      }),
    )

    expect(close.action).toBe('close')
    expect(close.descriptor.token).toBe(mach)
  })

  test('keeps using an existing channel in the challenge currency', async () => {
    const channelStore = createChannelStore()
    const poor = session({
      account,
      channelStore,
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 0n }),
    })
    const open = deserialize(
      await poor.createCredential({ challenge: makeChallenge(), context: {} }),
    )
    expect(open.descriptor.token).toBe(currency)

    const rich = session({
      account,
      channelStore,
      decimals: 0,
      getClient: () => createTestClient({ machBalance: 1_000n }),
    })
    const next = deserialize(
      await rich.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(next).toMatchObject({ action: 'voucher', channelId: open.channelId })
  })

  test('never auto-swaps into MACH', async () => {
    const findCalls = vi.spyOn(AutoSwap, 'findCalls')
    try {
      const method = session({
        account,
        autoSwap: { slippage: 2, tokenIn: ['0x0000000000000000000000000000000000000007'] },
        decimals: 0,
        getClient: () => createTestClient({ machBalance: 1_000n }),
      })

      const open = deserialize(
        await method.createCredential({ challenge: makeChallenge(), context: {} }),
      )

      expect(open.descriptor.token).toBe(mach)
      expect(openTransaction(open).calls).toHaveLength(1)
      expect(findCalls).not.toHaveBeenCalled()
    } finally {
      findCalls.mockRestore()
    }
  })
})

describe('MACH channel funding', () => {
  const resolvedFor = async (balances: Record<string, bigint>, methodDetails = {}) => {
    const client = createClient({
      account,
      chain: { id: chainId } as never,
      transport: custom(
        {
          async request(args) {
            if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
            if (args.method === 'eth_call') {
              const { data, to } = (args.params as [{ data: Hex; to?: Address }])[0]
              const balanceOf = (() => {
                try {
                  return decodeFunctionData({ abi: erc20Abi, data }).functionName === 'balanceOf'
                } catch {
                  return false
                }
              })()
              if (!balanceOf) return `0x${'00'.repeat(32)}`
              return encodeFunctionResult({
                abi: erc20Abi,
                functionName: 'balanceOf',
                result: balances[to?.toLowerCase() ?? ''] ?? 0n,
              })
            }
            throw new Error(`unexpected rpc request: ${args.method}`)
          },
        },
        { retryCount: 0 },
      ),
    })
    const { resolveChallengeContext } = await import('./CredentialState.js')
    return resolveChallengeContext({
      allowCustomEscrow: false,
      challenge: makeChallenge({ machTokenAccepted: true, ...methodDetails }),
      escrowOverride: undefined,
      allowedChainIds: undefined,
      getClient: async () => client,
    })
  }

  test('pays MACH channel fees in a stablecoin the payer holds', async () => {
    const { resolveMachineTokenContext, resolveMachineTokenFeeToken } =
      await import('./MachineToken.js')
    const pathUsd = defaults.tokens.pathUsd as Address
    const resolved = await resolvedFor({ [pathUsd.toLowerCase()]: 1_000_000n })
    const machine = resolveMachineTokenContext(resolved)!

    // The payer holds no challenge currency, so a reused channel's top-up must not pay fees in it.
    const feeToken = await resolveMachineTokenFeeToken({ account, resolved: machine })

    expect(feeToken?.toLowerCase()).toBe(pathUsd.toLowerCase())
  })

  test('keeps the server fee token for MACH channels', async () => {
    const { resolveMachineTokenContext, resolveMachineTokenFeeToken } =
      await import('./MachineToken.js')
    const advertised = '0x20c0000000000000000000000000000000000009' as Address
    const resolved = await resolvedFor({}, { feeToken: advertised })

    expect(
      await resolveMachineTokenFeeToken({
        account,
        resolved: resolveMachineTokenContext(resolved)!,
      }),
    ).toBe(advertised)
  })

  test('locks the MACH channel scope for machTokenAccepted challenges', async () => {
    const { getLockKeys, resolveMachineTokenContext } = await import('./MachineToken.js')
    const resolved = await resolvedFor({})

    // Both scopes, since an open for a MACH-direct challenge can fall back to the challenge currency.
    expect(getLockKeys(resolved)).toEqual([resolved.key, resolveMachineTokenContext(resolved)!.key])
    expect(getLockKeys({ ...resolved, machTokenAccepted: false })).toEqual([resolved.key])
  })
})
