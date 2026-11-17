import { createClient, custom, encodeErrorResult, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as Errors from '../../Errors.js'
import * as ChannelOps from '../session/client/ChannelOps.js'
import * as Simulation from './simulation.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const token = '0x20c0000000000000000000000000000000000001' as Address
const spendingLimitExceeded = encodeErrorResult({
  abi: Abis.accountKeychain,
  errorName: 'SpendingLimitExceeded',
})
const insufficientBalance = encodeErrorResult({
  abi: Abis.tip20,
  args: [487n, 20_000n, token],
  errorName: 'InsufficientBalance',
})

function createRevertingClient(data: `0x${string}`) {
  return createClient({
    account,
    chain: { id: 4217 } as never,
    transport: custom(
      {
        async request(args) {
          if (args.method === 'eth_chainId') return '0x1079'
          if (args.method === 'eth_getTransactionCount') return '0x0'
          if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
          if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
          if (args.method === 'eth_estimateGas')
            throw Object.assign(new Error('execution reverted'), { code: 3, data })
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      },
      { retryCount: 0 },
    ),
  })
}

describe('selectors', () => {
  test('match the Tempo revert selectors', () => {
    expect(spendingLimitExceeded).toBe('0x8a9e71ea')
    expect(insufficientBalance.slice(0, 10)).toBe('0x832f98b5')
  })
})

describe('toClientError', () => {
  test('maps SpendingLimitExceeded to SpendingLimitExceededError', () => {
    const cause = { cause: { data: spendingLimitExceeded } }
    const error = Simulation.toClientError(cause, {
      account: { accessKeyAddress: token, address: account.address },
    })
    expect(error).toBeInstanceOf(Errors.SpendingLimitExceededError)
    expect(error).toMatchObject({ accessKey: token, account: account.address, cause })
  })

  test('maps InsufficientBalance to InsufficientBalanceError', () => {
    const error = Simulation.toClientError({ data: { data: insufficientBalance } }, { account })
    expect(error).toBeInstanceOf(Errors.InsufficientBalanceError)
    expect(error?.message).toContain('holds 487 of token')
    expect(error?.message).toContain('requires 20000')
  })

  test('leaves other errors unmapped', () => {
    expect(Simulation.toClientError(new Error('boom'), { account })).toBeUndefined()
    expect(Simulation.toClientError({ data: '0xdeadbeef' }, { account })).toBeUndefined()
  })
})

describe('session transactions', () => {
  const descriptor = {
    authorizedSigner: account.address,
    expiringNonceHash: `0x${'00'.repeat(32)}` as `0x${string}`,
    operator: '0x0000000000000000000000000000000000000000' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    payer: account.address,
    salt: `0x${'11'.repeat(32)}` as `0x${string}`,
    token,
  }

  test('open throws SpendingLimitExceededError before signing', async () => {
    await expect(
      ChannelOps.createOpenPayload(createRevertingClient(spendingLimitExceeded), account, {
        chainId: 4217,
        deposit: 1_000_000n,
        feePayer: true,
        initialAmount: 0n,
        payee: descriptor.payee,
        token,
      }),
    ).rejects.toBeInstanceOf(Errors.SpendingLimitExceededError)
  })

  test('top-up throws InsufficientBalanceError before signing', async () => {
    await expect(
      ChannelOps.createTopUpPayload(
        createRevertingClient(insufficientBalance),
        account,
        descriptor,
        20_000n,
        4217,
        true,
      ),
    ).rejects.toBeInstanceOf(Errors.InsufficientBalanceError)
  })
})
