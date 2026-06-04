import { type Address, createClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as z from '../../../zod.js'
import * as Methods from '../../Methods.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import * as Types from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
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

type SessionChallenge = Challenge<
  z.output<typeof Methods.session.schema.request>,
  typeof Methods.session.intent,
  typeof Methods.session.name
>

function makeChallenge(overrides: Partial<SessionChallenge['request']> = {}): SessionChallenge {
  const request: SessionChallenge['request'] = {
    amount: '100',
    currency: descriptor.token,
    recipient: descriptor.payee,
    unitType: 'request',
    methodDetails: { chainId, escrowContract: tip20ChannelEscrow },
  }

  return {
    id: 'test-id',
    realm: 'test.com',
    method: 'tempo',
    intent: 'session',
    request: Object.assign(request, overrides),
  }
}

function deserialize(credential: string) {
  return Credential.deserialize(credential).payload as Types.SessionCredentialPayload
}

function deserializeCredential(credential: string) {
  return Credential.deserialize<Types.SessionCredentialPayload>(credential)
}

function openArgs(payload: Types.SessionCredentialPayload) {
  if (payload.action !== 'open') throw new Error('expected open payload')
  const transaction = Transaction.deserialize(payload.transaction)
  if (!('calls' in transaction)) throw new Error('expected tempo calls')
  const calls = transaction.calls as readonly { to?: Address; data?: `0x${string}` }[]
  const call = calls[0]!
  const decoded = decodeFunctionData({ abi: escrowAbi, data: call.data! })
  if (decoded.functionName !== 'open') throw new Error('expected open call')
  return decoded.args
}

function openDeposit(payload: Types.SessionCredentialPayload): bigint {
  return openArgs(payload)[3]
}

describe('precompile client session', () => {
  test('opens for the current amount without client deposit configuration', async () => {
    const method = session({ account, getClient: () => client })
    const payload = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(100n)
  })

  test('uses client chain ID when the challenge omits chain ID', async () => {
    const method = session({ account, getClient: () => client })
    const credential = deserializeCredential(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: { escrowContract: tip20ChannelEscrow },
        }),
        context: {},
      }),
    )
    const payload = credential.payload

    if (payload.action !== 'open') throw new Error('expected open payload')
    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    expect(payload.channelId).toBe(
      Channel.computeId({ ...payload.descriptor, chainId, escrow: tip20ChannelEscrow }),
    )
  })

  test('uses explicit context depositRaw before server hints', async () => {
    const method = session({ account, getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge(),
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
        challenge: makeChallenge({ suggestedDeposit: '1000' }),
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
        challenge: makeChallenge({ suggestedDeposit: '700' }),
        context: {},
      }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(700n)
  })

  test('uses current amount without suggestedDeposit even when maxDeposit is higher', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const payload = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(payload.action).toBe('open')
    expect(openDeposit(payload)).toBe(100n)
  })

  test('rejects open when maxDeposit is below the request amount', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '50', getClient: () => client })

    await expect(
      method.createCredential({ challenge: makeChallenge(), context: {} }),
    ).rejects.toThrow('requested voucher amount 100 exceeds local maxDeposit 50')
  })

  test('rejects explicit opening deposits below the request amount', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { depositRaw: '50' },
      }),
    ).rejects.toThrow('opening deposit 50 below request amount 100')
  })

  test('uses resolved escrow address for open transactions', async () => {
    const challengeEscrow = '0x0000000000000000000000000000000000000005' as Address
    const method = session({ account, decimals: 0, getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: { chainId, escrowContract: challengeEscrow },
        }),
        context: {},
      }),
    )

    if (payload.action !== 'open') throw new Error('expected open payload')
    const transaction = Transaction.deserialize(payload.transaction)
    if (!('calls' in transaction)) throw new Error('expected tempo calls')
    const calls = transaction.calls as readonly { to?: Address; data?: `0x${string}` }[]
    expect(calls[0]!.to?.toLowerCase()).toBe(challengeEscrow.toLowerCase())
    expect(payload.channelId).toBe(
      Channel.computeId({ ...payload.descriptor, chainId, escrow: challengeEscrow }),
    )
  })

  test('uses challenge-advertised operator for open transactions', async () => {
    const operator = '0x0000000000000000000000000000000000000006' as Address
    const method = session({ account, decimals: 0, getClient: () => client })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: { chainId, escrowContract: tip20ChannelEscrow, operator },
        }),
        context: {},
      }),
    )

    if (payload.action !== 'open') throw new Error('expected open payload')
    expect(openArgs(payload)[1].toLowerCase()).toBe(operator.toLowerCase())
    expect(payload.descriptor.operator.toLowerCase()).toBe(operator.toLowerCase())
  })

  test('tracks cumulative amount and calls onChannelUpdate in auto mode', async () => {
    const updates: bigint[] = []
    const method = session({
      account,
      decimals: 0,
      maxDeposit: '1000',
      getClient: () => client,
      onChannelUpdate: (entry) => updates.push(entry.cumulativeAmount),
    })
    const first = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )
    const second = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(first.action).toBe('open')
    expect(second.action).toBe('voucher')
    if (second.action !== 'voucher') throw new Error('expected voucher')
    expect(second.channelId).toBe(first.channelId)
    expect(second.cumulativeAmount).toBe('200')
    expect(updates).toEqual([100n, 200n])
  })

  test('enforces maxDeposit when reusing a cached auto-mode channel', async () => {
    const updates: bigint[] = []
    const method = session({
      account,
      decimals: 0,
      maxDeposit: '150',
      getClient: () => client,
      onChannelUpdate: (entry) => updates.push(entry.cumulativeAmount),
    })

    await method.createCredential({ challenge: makeChallenge(), context: {} })

    await expect(
      method.createCredential({ challenge: makeChallenge(), context: {} }),
    ).rejects.toThrow('requested voucher amount 200 exceeds local maxDeposit 150')
    expect(updates).toEqual([100n])
  })

  test('recovers and reuses a descriptor supplied in context', async () => {
    const updates: bigint[] = []
    const method = session({
      account,
      decimals: 0,
      maxDeposit: '1000',
      getClient: () => client,
      onChannelUpdate: (entry) => updates.push(entry.cumulativeAmount),
    })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const recovered = deserialize(
      await method.createCredential({
        challenge: makeChallenge(),
        context: { channelId, descriptor },
      }),
    )
    const next = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
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

  test('increments stored cumulative when recovering without a server snapshot', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge(),
        context: { channelId, cumulativeAmountRaw: '100', descriptor },
      }),
    )

    expect(payload.action).toBe('voucher')
    if (payload.action !== 'voucher') throw new Error('expected voucher')
    expect(payload.channelId).toBe(channelId)
    expect(payload.cumulativeAmount).toBe('200')
  })

  test('uses required server snapshot cumulative when recovering a channel', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: {
            chainId,
            escrowContract: tip20ChannelEscrow,
            sessionSnapshot: {
              acceptedCumulative: '400',
              channelId,
              deposit: '1000',
              descriptor,
              requiredCumulative: '400',
              settled: '0',
              spent: '300',
              units: 3,
            },
          },
        }),
        context: {},
      }),
    )

    expect(payload.action).toBe('voucher')
    if (payload.action !== 'voucher') throw new Error('expected voucher')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.cumulativeAmount).toBe('400')
  })

  test('uses accepted snapshot cumulative when it is above the required amount', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })
    const payload = deserialize(
      await method.createCredential({
        challenge: makeChallenge({
          methodDetails: {
            chainId,
            escrowContract: tip20ChannelEscrow,
            sessionSnapshot: {
              acceptedCumulative: '500',
              channelId,
              deposit: '1000',
              descriptor,
              requiredCumulative: '400',
              settled: '0',
              spent: '300',
              units: 3,
            },
          },
        }),
        context: {},
      }),
    )

    expect(payload.action).toBe('voucher')
    if (payload.action !== 'voucher') throw new Error('expected voucher')
    expect(payload.cumulativeAmount).toBe('500')
  })

  test('caps recovered voucher authorization by maxDeposit', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '300', getClient: () => client })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    await expect(
      method.createCredential({
        challenge: makeChallenge({
          methodDetails: {
            chainId,
            escrowContract: tip20ChannelEscrow,
            sessionSnapshot: {
              acceptedCumulative: '300',
              channelId,
              deposit: '1000',
              descriptor,
              requiredCumulative: '300',
              settled: '0',
              spent: '200',
            },
          },
        }),
        context: {},
      }),
    ).resolves.toBeDefined()

    const overLimitMethod = session({
      account,
      decimals: 0,
      maxDeposit: '300',
      getClient: () => client,
    })
    await expect(
      overLimitMethod.createCredential({
        challenge: makeChallenge({
          amount: '400',
          methodDetails: {
            chainId,
            escrowContract: tip20ChannelEscrow,
            sessionSnapshot: {
              acceptedCumulative: '1000',
              channelId,
              deposit: '1000',
              descriptor,
              requiredCumulative: '1000',
              settled: '0',
              spent: '300',
            },
          },
        }),
        context: {},
      }),
    ).rejects.toThrow('requested voucher amount 1000 exceeds local maxDeposit 300')
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
    const method = session({
      account,
      decimals: 0,
      maxDeposit: '1000',
      getClient: () => closedClient,
    })
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { channelId, descriptor },
      }),
    ).rejects.toThrow(/cannot be reused \(closed or not found on-chain\)/)
  })

  test('rejects channel recovery without descriptor', async () => {
    const method = session({ account, decimals: 0, maxDeposit: '1000', getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { channelId: `0x${'33'.repeat(32)}` },
      }),
    ).rejects.toThrow('descriptor required to reuse TIP-1034 channel')
  })

  test('defaults precompile authorizedSigner to account access key address', async () => {
    const accessKeyAddress = '0x0000000000000000000000000000000000000009' as Address
    const accessKeyAccount = Object.assign({}, account, { accessKeyAddress })
    const method = session({
      account: accessKeyAccount,
      decimals: 0,
      maxDeposit: '1000',
      getClient: () => client,
    })
    const payload = deserialize(
      await method.createCredential({ challenge: makeChallenge(), context: {} }),
    )

    expect(payload.action).toBe('open')
    if (payload.action !== 'open') throw new Error('expected open payload')
    expect(payload.descriptor.authorizedSigner).toBe(accessKeyAddress)
  })

  test('manual open requires transaction', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'open', descriptor, cumulativeAmountRaw: '100' },
      }),
    ).rejects.toThrow('transaction required for open action')
  })

  test('manual open requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'open', descriptor, transaction: '0x1234' },
      }),
    ).rejects.toThrow('cumulativeAmount required for open action')
  })

  test('manual topUp requires additionalDeposit', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'topUp', descriptor, transaction: '0x1234' },
      }),
    ).rejects.toThrow('additionalDeposit required for topUp action')
  })

  test('manual voucher requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'voucher', descriptor },
      }),
    ).rejects.toThrow('cumulativeAmount required for voucher action')
  })

  test('manual close requires cumulativeAmount', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'close', descriptor },
      }),
    ).rejects.toThrow('cumulativeAmount required for close action')
  })

  test('manual actions require descriptors', async () => {
    const method = session({ account, getClient: () => client })

    await expect(
      method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'voucher', cumulativeAmountRaw: '100' },
      }),
    ).rejects.toThrow('descriptor required for TIP-1034 session action')
  })

  test('creates manual voucher credentials with descriptor payloads', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge(),
      context: {
        action: 'voucher',
        descriptor,
        cumulativeAmountRaw: '250',
      },
    })

    const decoded = deserializeCredential(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload
    const cumulativeAmount = Types.uint96(250n)
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    expect(decoded.challenge.id).toBe('test-id')
    expect(decoded.challenge.realm).toBe('test.com')
    expect(decoded.challenge.method).toBe('tempo')
    expect(decoded.challenge.intent).toBe('session')
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

  test('creates manual open credentials with descriptor payloads', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge(),
      context: {
        action: 'open',
        descriptor,
        cumulativeAmountRaw: '250',
        transaction: '0x1234',
      },
    })

    const decoded = deserializeCredential(credential)
    const payload = decoded.payload
    const cumulativeAmount = Types.uint96(250n)
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    expect(decoded.challenge.id).toBe('test-id')
    expect(payload.action).toBe('open')
    if (payload.action !== 'open') throw new Error('expected open payload')
    expect(payload.type).toBe('transaction')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.transaction).toBe('0x1234')
    expect(payload.cumulativeAmount).toBe('250')
    expect(payload.authorizedSigner).toBe(descriptor.authorizedSigner)
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
      challenge: makeChallenge(),
      context: {
        action: 'topUp',
        descriptor,
        additionalDepositRaw: '500',
        transaction: '0x1234',
      },
    })

    const decoded = deserializeCredential(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    expect(payload.action).toBe('topUp')
    if (payload.action !== 'topUp') throw new Error('expected topUp payload')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.additionalDeposit).toBe('500')
    expect(payload.transaction).toBe('0x1234')
    expect(decoded.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('creates manual close credentials with descriptor payloads', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge(),
      context: {
        action: 'close',
        descriptor,
        cumulativeAmountRaw: '250',
      },
    })

    const decoded = deserializeCredential(credential)
    const payload = decoded.payload
    const cumulativeAmount = Types.uint96(250n)
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow: tip20ChannelEscrow })

    expect(payload.action).toBe('close')
    if (payload.action !== 'close') throw new Error('expected close payload')
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
})
