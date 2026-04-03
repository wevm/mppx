import { type Address, createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { deployEscrow, openChannel } from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

const isLocalnet = nodeEnv === 'localnet'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import { chainId, escrowContract as escrowContractDefaults } from '../internal/defaults.js'
import { createSessionReceipt, serializeSessionReceipt } from '../session/Receipt.js'
import type { SessionCredentialPayload } from '../session/Types.js'
import { session } from './Session.js'

function deserializePayload(result: string) {
  const cred = Credential.deserialize<SessionCredentialPayload>(result)
  return cred
}

const pureAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const pureClient = createClient({
  account: pureAccount,
  transport: http('http://127.0.0.1'),
})

const escrowAddress = escrowContractDefaults[chainId.testnet] as Address
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

  describe('server-authored hints', () => {
    const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex

    test('hydrates accounting hints without inflating the next signed voucher', async () => {
      const method = session({
        getClient: () => pureClient,
        account: pureAccount,
        deposit: '10',
      })

      const result = await method.createCredential({
        challenge: makeChallenge({
          methodDetails: {
            acceptedCumulative: '5000000',
            chainId: 42431,
            channelId,
            deposit: '10000000',
            escrowContract: escrowAddress,
            requiredCumulative: '6000000',
            spent: '4000000',
          },
        }),
        context: {},
      })

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('voucher')
      if (cred.payload.action === 'voucher') {
        expect(cred.payload.channelId).toBe(channelId)
        expect(cred.payload.cumulativeAmount).toBe('1000000')
      }
    })

    test('keeps cumulative strictly local across repeated hinted requests', async () => {
      const method = session({
        getClient: () => pureClient,
        account: pureAccount,
        deposit: '10',
      })

      const challenge = makeChallenge({
        methodDetails: {
          acceptedCumulative: '5000000',
          chainId: 42431,
          channelId,
          deposit: '10000000',
          escrowContract: escrowAddress,
          requiredCumulative: '6000000',
          spent: '5000000',
        },
      })

      const first = deserializePayload(await method.createCredential({ challenge, context: {} }))
      const second = deserializePayload(await method.createCredential({ challenge, context: {} }))

      expect(first.payload.action).toBe('voucher')
      expect(second.payload.action).toBe('voucher')
      if (first.payload.action === 'voucher') {
        expect(first.payload.cumulativeAmount).toBe('1000000')
      }
      if (second.payload.action === 'voucher') {
        expect(second.payload.cumulativeAmount).toBe('2000000')
      }
    })

    test('does not apply replacement hints to the current local channel when a server-supplied replacement cannot be verified', async () => {
      const channelIdA = '0x00000000000000000000000000000000000000000000000000000000000000aa' as Hex
      const channelIdB = '0x00000000000000000000000000000000000000000000000000000000000000bb' as Hex
      const updates: { channelId: Hex; spent: bigint }[] = []
      const method = session({
        getClient: () => pureClient,
        account: pureAccount,
        deposit: '10',
        onChannelUpdate(entry) {
          updates.push({ channelId: entry.channelId, spent: entry.spent })
        },
      })

      const challengeA = makeChallenge({
        methodDetails: {
          acceptedCumulative: '5000000',
          chainId: 42431,
          channelId: channelIdA,
          deposit: '10000000',
          escrowContract: escrowAddress,
          spent: '4000000',
        },
      })
      const challengeB = makeChallenge({
        methodDetails: {
          acceptedCumulative: '9000000',
          chainId: 42431,
          channelId: channelIdB,
          deposit: '12000000',
          escrowContract: escrowAddress,
          spent: '9000000',
        },
      })

      await method.createCredential({ challenge: challengeA, context: {} })
      const result = deserializePayload(
        await method.createCredential({ challenge: challengeB, context: {} }),
      )

      expect(result.payload.action).toBe('voucher')
      if (result.payload.action === 'voucher') {
        expect(result.payload.channelId).toBe(channelIdA)
        expect(result.payload.cumulativeAmount).toBe('2000000')
      }

      expect(updates[updates.length - 1]).toEqual({ channelId: channelIdA, spent: 4_000_000n })
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

      const cred = deserializePayload(result)
      expect(cred.challenge.id).toBe('test-challenge-id')
      expect(cred.challenge.realm).toBe('test.com')
      expect(cred.challenge.method).toBe('tempo')
      expect(cred.challenge.intent).toBe('session')
      expect(cred.payload.action).toBe('voucher')
      expect(cred.payload.channelId).toBe(channelId)
      if (cred.payload.action === 'voucher') {
        expect(cred.payload.cumulativeAmount).toBe('5000000')
        expect(cred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
      }
      expect(cred.source).toBe(`did:pkh:eip155:42431:${pureAccount.address}`)
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

      const cred = deserializePayload(result)
      expect(cred.challenge.id).toBe('test-challenge-id')
      expect(cred.payload.action).toBe('open')
      expect(cred.payload.channelId).toBe(channelId)
      if (cred.payload.action === 'open') {
        expect(cred.payload.type).toBe('transaction')
        expect(cred.payload.transaction).toBe('0xdeadbeef')
        expect(cred.payload.cumulativeAmount).toBe('5000000')
        expect(cred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
        expect(cred.payload.authorizedSigner).toBe(pureAccount.address)
      }
      expect(cred.source).toBe(`did:pkh:eip155:42431:${pureAccount.address}`)
    })

    test('manual close produces valid credential', async () => {
      const method = session({ getClient: () => pureClient, account: pureAccount })

      const result = await method.createCredential({
        challenge: makeChallenge(),
        context: { action: 'close', channelId, cumulativeAmount: '5' },
      })

      const cred = deserializePayload(result)
      expect(cred.challenge.id).toBe('test-challenge-id')
      expect(cred.payload.action).toBe('close')
      expect(cred.payload.channelId).toBe(channelId)
      if (cred.payload.action === 'close') {
        expect(cred.payload.cumulativeAmount).toBe('5000000')
        expect(cred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
      }
      expect(cred.source).toBe(`did:pkh:eip155:42431:${pureAccount.address}`)
    })
  })
})

describe.runIf(isLocalnet)('session (on-chain)', () => {
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('open')
      expect(cred.payload.channelId).toMatch(/^0x[0-9a-f]{64}$/)
      if (cred.payload.action === 'open') {
        expect(cred.payload.type).toBe('transaction')
        expect(cred.payload.cumulativeAmount).toBe('1000000')
        expect(cred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
      }
      expect(cred.source).toContain(`did:pkh:eip155:${chain.id}:`)
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('open')
      if (cred.payload.action === 'open') {
        expect(cred.payload.type).toBe('transaction')
        expect(cred.payload.cumulativeAmount).toBe('1000000')
      }
      expect(cred.source).toContain(`did:pkh:eip155:${chain.id}:`)
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('open')
      if (cred.payload.action === 'open') {
        expect(cred.payload.cumulativeAmount).toBe('1000000')
      }
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('open')
      if (cred.payload.action === 'open') {
        expect(cred.payload.cumulativeAmount).toBe('1000000')
      }
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('open')
      if (cred.payload.action === 'open') {
        expect(cred.payload.cumulativeAmount).toBe('1000000')
      }
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

      const cred = deserializePayload(result)
      expect(cred.payload.action).toBe('voucher')
      if (cred.payload.action === 'voucher') {
        expect(cred.payload.channelId).toBe(channelId)
        expect(cred.payload.cumulativeAmount).toBe('1000000')
        expect(cred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
      }
      expect(cred.source).toContain(`did:pkh:eip155:${chain.id}:`)
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

    test('throws when a server-supplied channelId cannot be recovered', async () => {
      const hintedChannelId =
        '0x0000000000000000000000000000000000000000000000000000000000000bad' as Hex
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      const challenge = makeLiveChallenge({
        methodDetails: {
          chainId: chain.id,
          channelId: hintedChannelId,
          deposit: '10000000',
          escrowContract,
        },
      })

      await expect(method.createCredential({ challenge, context: {} })).rejects.toThrow(
        'cannot be reused',
      )
    })

    test('ignores stale receipts after rebinding to a newly recovered channel', async () => {
      const { channelId: channelIdA } = await openChannel({
        escrow: escrowContract,
        payer,
        payee,
        token: asset,
        deposit: 10_000_000n,
        salt: nextSalt(),
      })
      const { channelId: channelIdB } = await openChannel({
        escrow: escrowContract,
        payer,
        payee,
        token: asset,
        deposit: 10_000_000n,
        salt: nextSalt(),
      })

      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      const challengeA = makeLiveChallenge({
        methodDetails: {
          chainId: chain.id,
          escrowContract,
          channelId: channelIdA,
        },
      })
      const challengeB = makeLiveChallenge({
        methodDetails: {
          chainId: chain.id,
          escrowContract,
          channelId: channelIdB,
        },
      })

      await method.createCredential({ challenge: challengeA, context: {} })
      await method.createCredential({ challenge: challengeB, context: {} })

      method.onResponse(
        new Response(null, {
          headers: {
            'Payment-Receipt': serializeSessionReceipt(
              createSessionReceipt({
                challengeId: challengeA.id,
                channelId: channelIdA,
                acceptedCumulative: 9_000_000n,
                spent: 9_000_000n,
              }),
            ),
          },
        }),
      )

      const result = deserializePayload(
        await method.createCredential({ challenge: challengeB, context: {} }),
      )

      expect(result.payload.action).toBe('voucher')
      if (result.payload.action === 'voucher') {
        expect(result.payload.channelId).toBe(channelIdB)
        expect(result.payload.cumulativeAmount).toBe('2000000')
      }
    })
  })

  describe('cumulative tracking in auto mode', () => {
    test('first call opens channel, second issues voucher with increased cumulative', async () => {
      const updates: { cumulativeAmount: bigint }[] = []
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
        onChannelUpdate: (entry) => updates.push({ cumulativeAmount: entry.cumulativeAmount }),
      })

      const challenge = makeLiveChallenge()

      const first = await method.createCredential({ challenge, context: {} })
      const firstCred = deserializePayload(first)
      expect(firstCred.payload.action).toBe('open')
      if (firstCred.payload.action === 'open') {
        expect(firstCred.payload.type).toBe('transaction')
        expect(firstCred.payload.cumulativeAmount).toBe('1000000')
      }

      const second = await method.createCredential({ challenge, context: {} })
      const secondCred = deserializePayload(second)
      expect(secondCred.payload.action).toBe('voucher')
      if (secondCred.payload.action === 'voucher') {
        expect(secondCred.payload.channelId).toBe(firstCred.payload.channelId)
        expect(secondCred.payload.cumulativeAmount).toBe('2000000')
        expect(secondCred.payload.signature).toMatch(/^0x[0-9a-f]+$/)
      }

      expect(updates.length).toBe(2)
      expect(updates[0]!.cumulativeAmount).toBe(1_000_000n)
      expect(updates[1]!.cumulativeAmount).toBe(2_000_000n)
    })

    test('does not let Payment-Receipt inflate the next voucher amount', async () => {
      const method = session({
        getClient: () => client,
        account: payer,
        deposit: '10',
        escrowContract,
      })

      const challenge = makeLiveChallenge()
      const first = await method.createCredential({ challenge, context: {} })
      const firstCred = deserializePayload(first)
      if (firstCred.payload.action !== 'open') throw new Error('expected open payload')

      method.onResponse(
        new Response(null, {
          headers: {
            'Payment-Receipt': serializeSessionReceipt(
              createSessionReceipt({
                challengeId: challenge.id,
                channelId: firstCred.payload.channelId,
                acceptedCumulative: 5_000_000n,
                spent: 3_000_000n,
              }),
            ),
          },
        }),
      )

      const second = await method.createCredential({ challenge, context: {} })
      const secondCred = deserializePayload(second)
      expect(secondCred.payload.action).toBe('voucher')
      if (secondCred.payload.action === 'voucher') {
        expect(secondCred.payload.cumulativeAmount).toBe('2000000')
      }
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
