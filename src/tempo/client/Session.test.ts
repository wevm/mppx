import { type Address, createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import { deployEscrow, openChannel } from '~test/tempo/stream.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'
import * as Challenge from '../../Challenge.js'
import { session } from './Session.js'

// ---------------------------------------------------------------------------
// Pure-test account + client (no real node needed)
// ---------------------------------------------------------------------------

const pureAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const pureClient = createClient({
  account: pureAccount,
  transport: http('http://127.0.0.1'),
})

const escrowAddress = '0x542831e3E4Ace07559b7C8787395f4Fb99F70787' as Address
const recipient = '0x2222222222222222222222222222222222222222' as Address
const currency = '0x3333333333333333333333333333333333333333' as Address

function makeChallenge(overrides?: Record<string, unknown>) {
  return Challenge.from({
    id: 'test-challenge-id',
    realm: 'test.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1000000',
      recipient,
      currency,
      unitType: 'token',
      methodDetails: {
        chainId: 42431,
        escrowContract: escrowAddress,
      },
      ...overrides,
    },
  }) as any
}

// ---------------------------------------------------------------------------
// Pure validation tests (no network)
// ---------------------------------------------------------------------------

describe('session (pure)', () => {
  describe('error: no action and no deposit/maxDeposit', () => {
    test('throws when neither configured', async () => {
      const method = session({
        getClient: () => pureClient,
        account: pureAccount,
      })

      await expect(
        method.createCredential({ challenge: makeChallenge(), context: {} }),
      ).rejects.toThrow('No `action` in context and no `deposit` or `maxDeposit` configured')
    })
  })

  describe('manual action validation', () => {
    const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

    test('open requires transaction', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'open', channelId, cumulativeAmount: '1' },
        }),
      ).rejects.toThrow('transaction required for open action')
    })

    test('open requires cumulativeAmount', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'open', channelId, transaction: '0xabc' },
        }),
      ).rejects.toThrow('cumulativeAmount required for open action')
    })

    test('topUp requires transaction', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'topUp', channelId, additionalDeposit: '5' },
        }),
      ).rejects.toThrow('transaction required for topUp action')
    })

    test('topUp requires additionalDeposit', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'topUp', channelId, transaction: '0xabc' },
        }),
      ).rejects.toThrow('additionalDeposit required for topUp action')
    })

    test('voucher requires cumulativeAmount', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'voucher', channelId },
        }),
      ).rejects.toThrow('cumulativeAmount required for voucher action')
    })

    test('close requires cumulativeAmount', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      await expect(
        method.createCredential({
          challenge: makeChallenge(),
          context: { action: 'close', channelId },
        }),
      ).rejects.toThrow('cumulativeAmount required for close action')
    })

    test('manual voucher produces valid credential', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      const result = await method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'voucher', channelId, cumulativeAmount: '5' },
      })

      expect(result).toMatch(/^Payment /)
    })

    test('manual open produces valid credential', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      const result = await method.createCredential({
        challenge: makeChallenge(),
        context: {
          action: 'open',
          channelId,
          cumulativeAmount: '5',
          transaction: '0xdeadbeef',
        },
      })

      expect(result).toMatch(/^Payment /)
    })

    test('manual close produces valid credential', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      const result = await method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'close', channelId, cumulativeAmount: '5' },
      })

      expect(result).toMatch(/^Payment /)
    })
  })
})

// ---------------------------------------------------------------------------
// On-chain tests (local node)
// ---------------------------------------------------------------------------

describe('session (on-chain)', () => {
  const payer = accounts[2]
  const payee = accounts[1].address
  let escrowContract: Address
  let saltCounter = 0

  function nextSalt(): Hex {
    saltCounter++
    return `0x${saltCounter.toString(16).padStart(64, '0')}` as Hex
  }

  function makeLiveChallenge(overrides?: Record<string, unknown>) {
    return Challenge.from({
      id: 'live-challenge',
      realm: 'test.com',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '1000000',
        recipient: payee,
        currency: asset,
        unitType: 'token',
        methodDetails: {
          chainId: chain.id,
          escrowContract,
        },
        ...overrides,
      },
    }) as any
  }

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: payer.address, token: Addresses.pathUsd })
    await fundAccount({ address: payer.address, token: asset })
  })

  describe('auto deposit selection', () => {
    test('context.depositRaw wins over everything', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '99',
        escrowContract,
      })

      const result = await method.createCredential({
        challenge: makeLiveChallenge(),
        context: { depositRaw: '5000000' },
      })

      expect(result).toMatch(/^Payment /)
    })

    test('suggestedDeposit capped by maxDeposit', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        maxDeposit: '5',
        escrowContract,
      })

      const challenge = makeLiveChallenge({ suggestedDeposit: '10000000' })

      const result = await method.createCredential({ challenge, context: {} })
      expect(result).toMatch(/^Payment /)
    })

    test('suggestedDeposit alone', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '99',
        escrowContract,
      })

      const challenge = makeLiveChallenge({ suggestedDeposit: '7000000' })

      const result = await method.createCredential({ challenge, context: {} })
      expect(result).toMatch(/^Payment /)
    })

    test('maxDeposit alone', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        maxDeposit: '10',
        escrowContract,
      })

      const result = await method.createCredential({
        challenge: makeLiveChallenge(),
        context: {},
      })
      expect(result).toMatch(/^Payment /)
    })

    test('parameters.deposit as last resort', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      const result = await method.createCredential({
        challenge: makeLiveChallenge(),
        context: {},
      })
      expect(result).toMatch(/^Payment /)
    })

    test('throws when no deposit source available', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        escrowContract,
      })

      await expect(
        method.createCredential({ challenge: makeLiveChallenge(), context: {} }),
      ).rejects.toThrow()
    })
  })

  describe('channel recovery', () => {
    test('recovers channel via suggestedChannelId', async () => {
      const salt = nextSalt()
      const { channelId } = await openChannel({
        escrow: escrowContract,
        payer,
        payee,
        token: asset,
        deposit: 10_000_000n,
        salt,
      })

      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      const challenge = makeLiveChallenge({
        methodDetails: {
          chainId: chain.id,
          escrowContract,
          channelId,
        },
      })

      const result = await method.createCredential({ challenge, context: {} })
      expect(result).toMatch(/^Payment /)
    })

    test('throws when explicit channelId cannot be recovered', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      await expect(
        method.createCredential({
          challenge: makeLiveChallenge(),
          context: {
            channelId: '0x0000000000000000000000000000000000000000000000000000000000000bad',
          },
        }),
      ).rejects.toThrow('cannot be reused')
    })
  })

  describe('cumulative tracking in auto mode', () => {
    test('cumulative amount increases across vouchers', async () => {
      const updates: { cumulativeAmount: bigint }[] = []
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
        onChannelUpdate: (entry) => updates.push({ cumulativeAmount: entry.cumulativeAmount }),
      })

      const challenge = makeLiveChallenge()

      await method.createCredential({ challenge, context: {} })
      await method.createCredential({ challenge, context: {} })

      expect(updates.length).toBe(2)
      expect(updates[1]!.cumulativeAmount).toBe(2_000_000n)
    })
  })

  describe('onChannelUpdate callback', () => {
    test('fires on auto-manage open', async () => {
      const updates: unknown[] = []
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
        onChannelUpdate: (entry) => updates.push(entry),
      })

      await method.createCredential({ challenge: makeLiveChallenge(), context: {} })

      expect(updates.length).toBeGreaterThan(0)
    })
  })
})
