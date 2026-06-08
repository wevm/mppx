import { createClient, custom, type Address, type Client, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import type * as z from '../../../zod.js'
import * as Channel from '../precompile/Channel.js'
import { tip20ChannelEscrow, type SessionCredentialPayload } from '../precompile/Protocol.js'
import type { SessionSnapshot } from '../Snapshot.js'
import type { ChannelEntry } from './ChannelOps.js'
import {
  channelKey,
  createChannelCache,
  hasCredentialCumulativeAmount,
  hasManualSessionDescriptor,
  hasSessionAction,
  hasSessionDescriptor,
  parseOptionalContextAmount,
  planCredential,
  readCredentialCumulativeAmount,
  requireContextAmount,
  resolveChallengeContext,
  resolveRecoverContext,
  resolveReusableChannel,
  sessionContextSchema,
  storeChannelEntry,
  updateCachedCumulative,
  type ChallengeContext,
  type SessionContext,
} from './CredentialState.js'

describe('ChannelCache', () => {
  const channelId = `0x${'11'.repeat(32)}` as Hex

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 10n,
      deposit: 20n,
      descriptor: {
        payer: '0x0000000000000000000000000000000000000001',
        payee: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000000',
        token: '0x20c0000000000000000000000000000000000001',
        salt: `0x${'22'.repeat(32)}`,
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash: `0x${'33'.repeat(32)}`,
      },
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  function voucher(cumulativeAmount: string): SessionCredentialPayload {
    return {
      action: 'voucher',
      channelId,
      descriptor: channel().descriptor,
      cumulativeAmount,
      signature: '0x1234',
    }
  }

  function close(cumulativeAmount: string): SessionCredentialPayload {
    return {
      action: 'close',
      channelId,
      descriptor: channel().descriptor,
      cumulativeAmount,
      signature: '0x1234',
    }
  }

  function topUp(additionalDeposit: string): SessionCredentialPayload {
    return {
      action: 'topUp',
      type: 'transaction',
      channelId,
      descriptor: channel().descriptor,
      transaction: '0x1234',
      additionalDeposit,
    }
  }

  describe('precompile client ChannelCache', () => {
    test('creates stable case-insensitive reusable channel keys', () => {
      expect(
        channelKey(
          '0x00000000000000000000000000000000000000AA' as Address,
          '0x20C0000000000000000000000000000000000001' as Address,
          '0x4D50500000000000000000000000000000000000' as Address,
        ),
      ).toBe(
        '0x00000000000000000000000000000000000000aa:0x20c0000000000000000000000000000000000001:0x4d50500000000000000000000000000000000000',
      )
    })

    test('stores entries by key and channel ID and notifies observers', () => {
      const updates: ChannelEntry[] = []
      const cache = createChannelCache((entry) => updates.push(entry))
      const entry = channel()

      storeChannelEntry(cache, 'payee:token:escrow', entry)

      expect(cache.channels.get('payee:token:escrow')).toBe(entry)
      expect(cache.channelIdToKey.get(channelId)).toBe('payee:token:escrow')
      expect(updates).toEqual([entry])
    })

    test('updates cached cumulative amounts monotonically', () => {
      const cache = createChannelCache()
      const entry = channel({ cumulativeAmount: 10n })
      storeChannelEntry(cache, 'payee:token:escrow', entry)

      updateCachedCumulative(cache, channelId, voucher('8'))
      expect(entry.cumulativeAmount).toBe(10n)

      updateCachedCumulative(cache, channelId, voucher('12'))
      expect(entry.cumulativeAmount).toBe(12n)
    })

    test('reads cumulative amounts only from cumulative credential payloads', () => {
      expect(hasCredentialCumulativeAmount(voucher('12'))).toBe(true)
      expect(readCredentialCumulativeAmount(voucher('12'))).toBe(12n)
      expect(hasCredentialCumulativeAmount(topUp('12'))).toBe(false)
      expect(readCredentialCumulativeAmount(topUp('12'))).toBeUndefined()
    })

    test('ignores non-cumulative top-up credentials when updating cached cumulative amount', () => {
      const cache = createChannelCache()
      const entry = channel({ cumulativeAmount: 10n })
      storeChannelEntry(cache, 'payee:token:escrow', entry)

      updateCachedCumulative(cache, channelId, topUp('12'))

      expect(entry.cumulativeAmount).toBe(10n)
    })

    test('marks cached channels closed from close credentials', () => {
      const cache = createChannelCache()
      const entry = channel({ opened: true })
      storeChannelEntry(cache, 'payee:token:escrow', entry)

      updateCachedCumulative(cache, channelId, close('12'))

      expect(entry.cumulativeAmount).toBe(12n)
      expect(entry.opened).toBe(false)
    })
  })
})

describe('Context', () => {
  const descriptor = {
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    operator: '0x0000000000000000000000000000000000000000' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    salt: `0x${'11'.repeat(32)}` as const,
    authorizedSigner: '0x0000000000000000000000000000000000000001' as Address,
    expiringNonceHash: `0x${'22'.repeat(32)}` as const,
  }

  describe('precompile session client context helpers', () => {
    test('keeps runtime schema aligned with documented context type', () => {
      type SchemaContext = z.infer<typeof sessionContextSchema>
      expectTypeOf<SchemaContext>().toEqualTypeOf<SessionContext>()
    })

    test('narrows manual action context', () => {
      expect(hasSessionAction({ action: 'voucher' })).toBe(true)
      expect(hasSessionAction({})).toBe(false)
      expect(hasSessionAction(undefined)).toBe(false)
    })

    test('narrows descriptor recovery context', () => {
      expect(hasSessionDescriptor({ descriptor })).toBe(true)
      expect(hasSessionDescriptor({})).toBe(false)
      expect(hasSessionDescriptor(undefined)).toBe(false)
    })

    test('narrows manual action context with descriptor', () => {
      expect(hasManualSessionDescriptor({ action: 'voucher', descriptor })).toBe(true)
      expect(hasManualSessionDescriptor({ action: 'voucher' })).toBe(false)
      expect(hasManualSessionDescriptor({ descriptor })).toBe(false)
    })

    test('prefers raw amount fields over human-readable amount fields', () => {
      expect(
        parseOptionalContextAmount(
          {
            cumulativeAmount: '100',
            cumulativeAmountRaw: '42',
          },
          6,
          'cumulativeAmount',
        ),
      ).toBe(42n)
    })

    test('parses human-readable amount fields with caller decimals', () => {
      expect(parseOptionalContextAmount({ additionalDeposit: '1.5' }, 6, 'additionalDeposit')).toBe(
        1_500_000n,
      )
    })

    test('returns undefined for absent optional amounts', () => {
      expect(parseOptionalContextAmount({}, 6, 'cumulativeAmount')).toBeUndefined()
    })

    test('throws action-specific errors for absent required amounts', () => {
      expect(() => requireContextAmount({}, 6, 'cumulativeAmount', 'voucher')).toThrow(
        'cumulativeAmount required for voucher action',
      )
    })
  })
})

describe('CredentialPlan', () => {
  const account = privateKeyToAccount(
    '0x1000000000000000000000000000000000000000000000000000000000000000',
  )
  const channelId = `0x${'11'.repeat(32)}` as Hex
  const snapshotChannelId = `0x${'12'.repeat(32)}` as Hex
  const escrow = '0x4D50500000000000000000000000000000000000' as Address
  const payee = '0x0000000000000000000000000000000000000002' as Address
  const token = '0x20c0000000000000000000000000000000000001' as Address

  const descriptor = {
    payer: account.address,
    payee,
    operator: '0x0000000000000000000000000000000000000000' as Address,
    token,
    salt: `0x${'22'.repeat(32)}` as Hex,
    authorizedSigner: account.address,
    expiringNonceHash: `0x${'33'.repeat(32)}` as Hex,
  }

  const snapshotDescriptor = {
    ...descriptor,
    salt: `0x${'44'.repeat(32)}` as Hex,
  }

  const client = createClient({
    transport: custom({
      async request() {
        return null
      },
    }),
  })

  function challengeContext(overrides: Partial<ChallengeContext> = {}): ChallengeContext {
    return {
      amount: 5n,
      challenge: Challenge.from({
        id: 'challenge-1',
        realm: 'example.test',
        method: 'tempo',
        intent: 'session',
        request: {},
      }),
      chainId: 4217,
      client,
      escrow,
      key: 'payee:token:escrow',
      payee,
      token,
      ...overrides,
    }
  }

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 10n,
      deposit: 20n,
      descriptor,
      escrow,
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      acceptedCumulative: '10',
      chainId: 42431,
      channelId: snapshotChannelId,
      deposit: '20',
      descriptor: snapshotDescriptor,
      escrow,
      requiredCumulative: '10',
      settled: '0',
      spent: '0',
      ...overrides,
    }
  }

  function paymentChallenge(
    overrides: Partial<Challenge.Challenge['request']> = {},
  ): Challenge.Challenge {
    return {
      id: 'challenge-1',
      realm: 'test',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '10',
        currency: token,
        methodDetails: {
          chainId: 42431,
          escrowContract: escrow,
          feePayer: true,
          [Constants.MethodDetailKeys.sessionSnapshot]: snapshot(),
        },
        recipient: payee,
        suggestedDeposit: '100',
        unitType: 'request',
        ...overrides,
      },
    }
  }

  describe('precompile client CredentialPlan', () => {
    test('resolves typed credential-planning fields from challenge details', async () => {
      const client = { chain: { id: 42431 } } as Client
      const resolved = await resolveChallengeContext({
        challenge: paymentChallenge(),
        getClient: async () => client,
      })

      expect(resolved).toMatchObject({
        amount: 10n,
        chainId: 42431,
        client,
        escrow,
        feePayer: true,
        payee,
        snapshot: snapshot(),
        suggestedDepositRaw: '100',
        token,
      })
      expect(resolved.key).toBe(
        `${payee.toLowerCase()}:${token.toLowerCase()}:${escrow.toLowerCase()}`,
      )
    })

    test('uses client chain ID when the challenge omits one', async () => {
      const resolved = await resolveChallengeContext({
        challenge: paymentChallenge({ methodDetails: { escrowContract: escrow } }),
        getClient: async () => ({ chain: { id: 4217 } }) as Client,
      })

      expect(resolved.chainId).toBe(4217)
    })

    test('rejects challenges without required payment fields', async () => {
      await expect(
        resolveChallengeContext({
          challenge: paymentChallenge({ recipient: undefined }),
          getClient: async () => ({ chain: { id: 4217 } }) as Client,
        }),
      ).rejects.toThrow('tempo session challenge missing recipient')

      await expect(
        resolveChallengeContext({
          challenge: paymentChallenge({ currency: 'pathUSD' }),
          getClient: async () => ({ chain: { id: 4217 } }) as Client,
        }),
      ).rejects.toThrow('tempo session challenge missing currency')
    })

    test('ignores invalid optional escrow hints', async () => {
      const resolved = await resolveChallengeContext({
        challenge: paymentChallenge({
          methodDetails: {
            chainId: 42431,
            escrowContract: 'not-an-address',
          },
        }),
        getClient: async () => ({ chain: { id: 42431 } }) as Client,
      })

      expect(resolved.escrow).toBe(tip20ChannelEscrow)
    })

    test('recover context prefers caller descriptor and channel ID over server snapshot', () => {
      expect(
        resolveRecoverContext({
          context: { channelId, descriptor },
          snapshot: snapshot(),
        }),
      ).toMatchObject({
        channelId,
        descriptor,
      })
    })

    test('recover context can be bootstrapped entirely from server snapshot', () => {
      expect(resolveRecoverContext({ snapshot: snapshot() })).toMatchObject({
        channelId: snapshotChannelId,
        descriptor: snapshotDescriptor,
      })
    })

    test('plans manual credentials only when an explicit action includes descriptor', () => {
      const cache = createChannelCache()
      const plan = planCredential({
        account,
        cache,
        context: { action: 'voucher', descriptor, cumulativeAmountRaw: '10' },
        decimals: 6,
        resolved: challengeContext(),
      })

      expect(plan.type).toBe('manual')
      if (plan.type !== 'manual') throw new Error('expected manual plan')
      expect(plan.context.descriptor).toBe(descriptor)
    })

    test('rejects manual actions without a descriptor', () => {
      expect(() =>
        planCredential({
          account,
          cache: createChannelCache(),
          context: { action: 'voucher', cumulativeAmountRaw: '10' },
          decimals: 6,
          resolved: challengeContext(),
        }),
      ).toThrow('descriptor required for TIP-1034 session action')
    })

    test('plans recovery from server snapshot when no reusable cache entry exists', () => {
      const plan = planCredential({
        account,
        cache: createChannelCache(),
        decimals: 6,
        resolved: challengeContext({ snapshot: snapshot() }),
      })

      expect(plan.type).toBe('recover')
      if (plan.type !== 'recover') throw new Error('expected recover plan')
      expect(plan.context.channelId).toBe(snapshotChannelId)
      expect(plan.context.descriptor).toBe(snapshotDescriptor)
    })

    test('plans voucher reuse before snapshot recovery when cache entry is open', () => {
      const cache = createChannelCache()
      const entry = channel()
      storeChannelEntry(cache, 'payee:token:escrow', entry)

      const plan = planCredential({
        account,
        cache,
        decimals: 6,
        resolved: challengeContext({ snapshot: snapshot() }),
      })

      expect(plan).toMatchObject({ type: 'voucher', entry })
    })

    test('rejects channel ID reuse without descriptor or cache entry', () => {
      expect(() =>
        planCredential({
          account,
          cache: createChannelCache(),
          context: { channelId },
          decimals: 6,
          resolved: challengeContext(),
        }),
      ).toThrow('descriptor required to reuse TIP-1034 channel')
    })

    test('returns descriptor-derived channel ID and reusable on-chain state', async () => {
      const state = { deposit: 1_000n, settled: 250n, closeRequestedAt: 0 }
      const reusableChannelId = Channel.computeId({ ...descriptor, chainId: 42431, escrow })

      await expect(
        resolveReusableChannel({
          channelId: reusableChannelId,
          client,
          descriptor,
          expected: { chainId: 42431, escrow, payee, token },
          readChannelState: async () => state,
        }),
      ).resolves.toEqual({ channelId: reusableChannelId, state })
    })

    test('rejects reusable channel descriptor mismatches before reading chain state', async () => {
      const cases = [
        {
          name: 'channel ID',
          parameters: { channelId: `0x${'ff'.repeat(32)}` },
          message: 'context channelId does not match descriptor',
        },
        {
          name: 'payee',
          parameters: {
            descriptor: {
              ...descriptor,
              payee: '0x0000000000000000000000000000000000000003' as Address,
            },
          },
          message: 'context descriptor payee does not match challenge',
        },
        {
          name: 'token',
          parameters: {
            descriptor: {
              ...descriptor,
              token: '0x0000000000000000000000000000000000000004' as Address,
            },
          },
          message: 'context descriptor token does not match challenge',
        },
      ] as const

      for (const item of cases) {
        let reads = 0
        await expect(
          resolveReusableChannel({
            client,
            descriptor,
            expected: { chainId: 42431, escrow, payee, token },
            readChannelState: async () => {
              reads += 1
              return { deposit: 1n, settled: 0n, closeRequestedAt: 0 }
            },
            ...item.parameters,
          }),
        ).rejects.toThrow(item.message)
        expect(reads, item.name).toBe(0)
      }
    })

    test('rejects non-reusable on-chain state', async () => {
      const reusableChannelId = Channel.computeId({ ...descriptor, chainId: 42431, escrow })
      const cases = [
        {
          state: { deposit: 0n, settled: 0n, closeRequestedAt: 0 },
          message: /cannot be reused \(closed or not found on-chain\)/,
        },
        {
          state: { deposit: 1_000n, settled: 0n, closeRequestedAt: 123 },
          message: /cannot be reused \(pending close request\)/,
        },
      ] as const

      for (const item of cases) {
        await expect(
          resolveReusableChannel({
            channelId: reusableChannelId,
            client,
            descriptor,
            expected: { chainId: 42431, escrow, payee, token },
            readChannelState: async () => item.state,
          }),
        ).rejects.toThrow(item.message)
      }
    })
  })
})
