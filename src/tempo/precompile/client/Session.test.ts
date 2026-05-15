import { type Address, createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import * as Types from '../Types.js'
import * as Voucher from '../Voucher.js'
import { session } from './Session.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const chainId = 42431
const client = createClient({
  account,
  chain: { id: chainId } as never,
  transport: custom({
    async request(args) {
      if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (args.method === 'eth_getTransactionCount') return '0x0'
      if (args.method === 'eth_estimateGas') return '0x5208'
      if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
      if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
      if (args.method === 'eth_call')
        return encodeFunctionResult({
          abi: escrowAbi,
          functionName: 'getChannelState',
          result: { settled: 0n, deposit: 1_000n, closeRequestedAt: 0 },
        })
      throw new Error(`unexpected rpc request: ${args.method}`)
    },
  }),
})

const descriptor = {
  payer: account.address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  token: '0x0000000000000000000000000000000000000003' as Address,
  salt: `0x${'11'.repeat(32)}` as `0x${string}`,
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as `0x${string}`,
} satisfies Channel.ChannelDescriptor

function makeChallenge(overrides: Record<string, unknown> = {}): Challenge {
  return {
    id: 'test-id',
    realm: 'test.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '100',
      currency: descriptor.token,
      recipient: descriptor.payee,
      methodDetails: { chainId, escrowContract: tip20ChannelEscrow },
      ...overrides,
    },
  }
}

function deserialize(credential: string) {
  return Credential.deserialize(credential).payload as Types.SessionCredentialPayload
}

function openDeposit(payload: Types.SessionCredentialPayload): bigint {
  if (payload.action !== 'open') throw new Error('expected open payload')
  const transaction = Transaction.deserialize(payload.transaction)
  if (!('calls' in transaction)) throw new Error('expected tempo calls')
  const calls = transaction.calls as readonly { to?: Address; data?: `0x${string}` }[]
  const call = calls[0]!
  const decoded = decodeFunctionData({ abi: escrowAbi, data: call.data! })
  if (decoded.functionName !== 'open') throw new Error('expected open call')
  return decoded.args[3]
}

describe('precompile client session', () => {
  test('throws without action, descriptor, deposit, maxDeposit, or suggestedDeposit', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    ).rejects.toThrow('No `action` in context and no `deposit` or `maxDeposit` configured')
  })

  test('uses context depositRaw before configured deposit', async () => {
    const method = session({ account, deposit: '99', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge() as never,
        context: { depositRaw: '500' },
      }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(500n)
  })

  test('caps suggestedDeposit by maxDeposit', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '500', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({ suggestedDeposit: '1000' }) as never,
        context: {},
      }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(500n)
  })

  test('uses suggestedDeposit when below maxDeposit', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({ suggestedDeposit: '700' }) as never,
        context: {},
      }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(700n)
  })

  test('uses maxDeposit without suggestedDeposit', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(1000n)
  })

  test('uses canonical precompile address for open transactions', async () => {
    const challengeEscrow = '0x0000000000000000000000000000000000000005' as Address
    const method = session({ account, decimals: 0, deposit: '10', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: { chainId, escrowContract: challengeEscrow },
        }) as never,
        context: {},
      }),
    )

    if (payload.action !== 'open') throw new Error('expected open payload')
    const transaction = Transaction.deserialize(payload.transaction)
    if (!('calls' in transaction)) throw new Error('expected tempo calls')
    const calls = transaction.calls as readonly { to?: Address; data?: `0x${string}` }[]
    expect(calls[0]!.to?.toLowerCase()).toBe(tip20ChannelEscrow.toLowerCase())
  })

  test('tracks cumulative amount and calls onChannelUpdate in auto mode', async () => {
    const updates: bigint[] = []
    const method = session({
      account,
      decimals: 0,
      deposit: '1000',
      getClient: () => client,
      onChannelUpdate: (entry) => updates.push(entry.cumulativeAmount),
    })
    const first = deserialize(
      await method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    )
    const second = deserialize(
      await method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    )

    expect(first.action).toBe('open')
    expect(second.action).toBe('voucher')
    if (second.action !== 'voucher') throw new Error('expected voucher')
    expect(second.channelId).toBe(first.channelId)
    expect(second.cumulativeAmount).toBe('200')
    expect(updates).toEqual([100n, 200n])
  })

  test('recovers and reuses a descriptor supplied in context', async () => {
    const updates: bigint[] = []
    const method = session({
      account,
      decimals: 0,
      deposit: '1000',
      getClient: () => client,
      onChannelUpdate: (entry) => updates.push(entry.cumulativeAmount),
    })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const recovered = deserialize(
      await method.createCredential({
        challenge: makeChallenge() as never,
        context: { channelId, descriptor },
      }),
    )
    const next = deserialize(
      await method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    )

    expect(recovered.action).toBe('voucher')
    if (recovered.action !== 'voucher' || next.action !== 'voucher')
      throw new Error('expected voucher')
    expect(recovered.channelId).toBe(channelId)
    expect(recovered.cumulativeAmount).toBe('100')
    expect(next.channelId).toBe(channelId)
    expect(next.cumulativeAmount).toBe('200')
    expect(updates).toEqual([100n, 200n])
  })

  test('rejects descriptor recovery for closed or missing channels', async () => {
    const closedClient = createClient({
      account,
      chain: { id: chainId } as never,
      transport: custom({
        async request(args) {
          if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
          if (args.method === 'eth_call')
            return encodeFunctionResult({
              abi: escrowAbi,
              functionName: 'getChannelState',
              result: { settled: 0n, deposit: 0n, closeRequestedAt: 0 },
            })
          throw new Error(`unexpected rpc request: ${args.method}`)
        },
      }),
    })
    const method = session({ account, decimals: 0, deposit: '1000', getClient: () => closedClient })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { channelId, descriptor },
      }),
    ).rejects.toThrow(/cannot be reused \(closed or not found on-chain\)/)
  })

  test('rejects channel recovery without descriptor', async () => {
    const method = session({ account, decimals: 0, deposit: '1000', getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { channelId: `0x${'33'.repeat(32)}` },
      }),
    ).rejects.toThrow('descriptor required to reuse precompile channel')
  })

  test('defaults precompile authorizedSigner to account access key address', async () => {
    const accessKeyAddress = '0x0000000000000000000000000000000000000009' as Address
    const accessKeyAccount = Object.assign({}, account, { accessKeyAddress })
    const method = session({
      account: accessKeyAccount,
      decimals: 0,
      deposit: '1000',
      getClient: () => client,
    })
    const payload = deserialize(
      await method.createCredential({ challenge: makeChallenge() as never, context: {} }),
    )

    expect(payload.action).toBe('open')
    if (payload.action !== 'open') throw new Error('expected open payload')
    expect(payload.descriptor.authorizedSigner).toBe(accessKeyAddress)
  })

  test('manual open requires transaction', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'open', descriptor, cumulativeAmountRaw: '100' },
      }),
    ).rejects.toThrow('transaction required for open action')
  })

  test('manual open requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'open', descriptor, transaction: '0x1234' },
      }),
    ).rejects.toThrow('cumulativeAmount required for open action')
  })

  test('manual topUp requires additionalDeposit', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'topUp', descriptor, transaction: '0x1234' },
      }),
    ).rejects.toThrow('additionalDeposit required for topUp action')
  })

  test('manual voucher requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'voucher', descriptor },
      }),
    ).rejects.toThrow('cumulativeAmount required for voucher action')
  })

  test('manual close requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'close', descriptor },
      }),
    ).rejects.toThrow('cumulativeAmount required for close action')
  })

  test('manual actions require descriptors', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge() as never,
        context: { action: 'voucher', cumulativeAmountRaw: '100' },
      }),
    ).rejects.toThrow('descriptor required for precompile session action')
  })

  test('creates manual voucher credentials with descriptor payloads', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge() as never,
      context: {
        action: 'voucher',
        descriptor,
        cumulativeAmountRaw: '250',
      },
    })

    const decoded = Credential.deserialize(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload
    const cumulativeAmount = Types.uint96(250n)
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    expect(payload.action).toBe('voucher')
    if (payload.action !== 'voucher') throw new Error('expected voucher payload')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.cumulativeAmount).toBe('250')
    expect(decoded.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    expect(
      Voucher.verifyVoucher(
        tip20ChannelEscrow,
        chainId,
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
      ),
    ).toBe(true)
  })

  test('creates manual top-up credentials from provided transactions', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge() as never,
      context: {
        action: 'topUp',
        descriptor,
        additionalDepositRaw: '500',
        transaction: '0x1234',
      },
    })

    const decoded = Credential.deserialize(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload

    expect(payload.action).toBe('topUp')
    if (payload.action !== 'topUp') throw new Error('expected topUp payload')
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.additionalDeposit).toBe('500')
    expect(payload.transaction).toBe('0x1234')
  })
})
