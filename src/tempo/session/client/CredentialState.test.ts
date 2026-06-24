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
  createChannelStore,
  createJsonChannelStore,
  deserializeEntry,
  entryKey,
  serializeEntry,
  type ChannelSink,
} from './ChannelStore.js'
import {
  canSignDescriptor,
  executeCredentialPlan,
  hasCredentialCumulativeAmount,
  hasManualSessionDescriptor,
  hasSessionAction,
  hasSessionDescriptor,
  parseOptionalContextAmount,
  planCredential,
  readCredentialCumulativeAmount,
  requireContextAmount,
  resolveChallengeContext,
  resolveRecoveredCumulative,
  resolveRecoverContext,
  resolveReusableChannel,
  sessionContextSchema,
  type ChallengeContext,
  type SessionContext,
} from './CredentialState.js'

/** Builds a credential sink backed by a fresh in-memory store. */
function sink(): ChannelSink {
  return { store: createChannelStore(), notifyUpdate: () => {} }
}

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

  describe('precompile client ChannelStore', () => {
    test('creates stable case-insensitive reusable channel keys scoped by chain', () => {
      expect(
        channelKey({
          payee: '0x00000000000000000000000000000000000000AA' as Address,
          token: '0x20C0000000000000000000000000000000000001' as Address,
          escrow: '0x4D50500000000000000000000000000000000000' as Address,
          chainId: 4217,
        }),
      ).toBe(
        '0x00000000000000000000000000000000000000aa:0x20c0000000000000000000000000000000000001:0x4d50500000000000000000000000000000000000:4217',
      )
    })

    test('derives a stored entry key from its descriptor, escrow, and chain', () => {
      const entry = channel()
      expect(entryKey(entry)).toBe(
        channelKey({
          payee: entry.descriptor.payee,
          token: entry.descriptor.token,
          escrow: entry.escrow,
          chainId: entry.chainId,
        }),
      )
    })

    test('stores, gets, and deletes entries by derived key', () => {
      const store = createChannelStore()
      const entry = channel()
      store.set(entry)

      expect(store.get(entryKey(entry))).toBe(entry)

      store.delete(entryKey(entry))
      expect(store.get(entryKey(entry))).toBeUndefined()
    })

    test('replaces entries that share a scope key', () => {
      const store = createChannelStore()
      const first = channel({ cumulativeAmount: 10n })
      const second = channel({ cumulativeAmount: 12n })
      store.set(first)
      store.set(second)

      expect(store.get(entryKey(second))).toBe(second)
    })

    test('reads cumulative amounts only from cumulative credential payloads', () => {
      expect(hasCredentialCumulativeAmount(voucher('12'))).toBe(true)
      expect(readCredentialCumulativeAmount(voucher('12'))).toBe(12n)
      expect(hasCredentialCumulativeAmount(topUp('12'))).toBe(false)
      expect(readCredentialCumulativeAmount(topUp('12'))).toBeUndefined()
    })
  })

  describe('serialization', () => {
    test('serializes bigint amounts to decimal strings', () => {
      const entry = channel({ cumulativeAmount: 2n ** 70n, deposit: 0n })
      const stored = serializeEntry(entry)
      expect(stored.cumulativeAmount).toBe((2n ** 70n).toString())
      expect(stored.deposit).toBe('0')
    })

    test('round-trips a channel entry through JSON', () => {
      const entry = channel({ cumulativeAmount: 2n ** 100n + 7n, deposit: 999n })
      const roundtrip = deserializeEntry(
        JSON.parse(JSON.stringify(serializeEntry(entry))) as ReturnType<typeof serializeEntry>,
      )
      expect(roundtrip).toEqual(entry)
    })
  })

  describe('createJsonChannelStore', () => {
    function jsonStore() {
      const backend = new Map<string, string>()
      const store = createJsonChannelStore({
        get: (key) => backend.get(key),
        set: (key, value) => {
          backend.set(key, value)
        },
        delete: (key) => {
          backend.delete(key)
        },
      })
      return { backend, store }
    }

    test('persists, gets, and deletes via a string KV backend', async () => {
      const { backend, store } = jsonStore()
      const entry = channel({ cumulativeAmount: 2n ** 64n, deposit: 5n })
      await store.set(entry)

      expect(backend.size).toBe(1)
      expect(await store.get(entryKey(entry))).toEqual(entry)

      await store.delete(entryKey(entry))
      expect(await store.get(entryKey(entry))).toBeUndefined()
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
        `${payee.toLowerCase()}:${token.toLowerCase()}:${escrow.toLowerCase()}:42431`,
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

    test('recovery cumulative ignores server-advertised unused voucher headroom', () => {
      expect(
        resolveRecoveredCumulative({
          context: { descriptor, channelId },
          decimals: 6,
          requestAmount: 5n,
          settled: 0n,
          snapshot: snapshot({
            acceptedCumulative: '1000000',
            requiredCumulative: '1000000',
            spent: '10',
          }),
        }),
      ).toBe(15n)
    })

    test('plans manual credentials only when an explicit action includes descriptor', () => {
      const plan = planCredential({
        account,
        entry: undefined,
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
          entry: undefined,
          context: { action: 'voucher', cumulativeAmountRaw: '10' },
          decimals: 6,
          resolved: challengeContext(),
        }),
      ).toThrow('descriptor required for TIP-1034 session action')
    })

    test('rejects manual descriptors that do not match the active challenge', async () => {
      const plan = planCredential({
        account,
        entry: undefined,
        context: {
          action: 'voucher',
          cumulativeAmountRaw: '10',
          descriptor: {
            ...descriptor,
            payee: '0x0000000000000000000000000000000000000003' as Address,
          },
        },
        decimals: 6,
        resolved: challengeContext(),
      })

      await expect(executeCredentialPlan(plan, sink())).rejects.toThrow(
        'context descriptor payee does not match challenge',
      )
    })

    test('leaves stored scope entry unchanged when a manual credential targets another channel', async () => {
      const entry = channel()
      const originalCumulative = entry.cumulativeAmount
      const notifications: ChannelEntry[] = []
      const store = createChannelStore()
      const manualDescriptor = { ...descriptor, salt: `0x${'55'.repeat(32)}` as Hex }
      await store.set(entry)

      await executeCredentialPlan(
        planCredential({
          account,
          entry,
          context: {
            action: 'voucher',
            descriptor: manualDescriptor,
            cumulativeAmountRaw: '25',
          },
          decimals: 6,
          resolved: challengeContext(),
        }),
        { store, notifyUpdate: (updated) => notifications.push(updated) },
      )

      const stored = await store.get(entryKey(entry))
      expect(stored?.channelId).toBe(entry.channelId)
      expect(stored?.cumulativeAmount).toBe(originalCumulative)
      expect(notifications).toEqual([])
    })

    test('plans recovery from server snapshot when no reusable cache entry exists', () => {
      const plan = planCredential({
        account,
        entry: undefined,
        decimals: 6,
        resolved: challengeContext({ snapshot: snapshot() }),
      })

      expect(plan.type).toBe('recover')
      if (plan.type !== 'recover') throw new Error('expected recover plan')
      expect(plan.context.channelId).toBe(snapshotChannelId)
      expect(plan.context.descriptor).toBe(snapshotDescriptor)
    })

    test('plans voucher reuse before snapshot recovery when cache entry is open', () => {
      const entry = channel()

      const plan = planCredential({
        account,
        entry,
        decimals: 6,
        resolved: challengeContext({ snapshot: snapshot() }),
      })

      expect(plan).toMatchObject({ type: 'voucher', entry })
    })

    test('opens fresh instead of vouchering when the account cannot sign the cached entry', () => {
      const entry = channel({
        descriptor: {
          ...descriptor,
          authorizedSigner: '0x00000000000000000000000000000000000000aa' as Address,
        },
      })

      const plan = planCredential({
        account,
        entry,
        decimals: 6,
        resolved: challengeContext(),
      })

      expect(plan.type).toBe('open')
    })

    test('opens fresh instead of recovering when the account cannot sign the snapshot', () => {
      const plan = planCredential({
        account,
        entry: undefined,
        decimals: 6,
        resolved: challengeContext({
          snapshot: snapshot({
            descriptor: {
              ...snapshotDescriptor,
              authorizedSigner: '0x00000000000000000000000000000000000000aa' as Address,
            },
          }),
        }),
      })

      expect(plan.type).toBe('open')
    })

    test('vouchers when the account can satisfy the cached voucher authority', () => {
      const delegatedAccount = privateKeyToAccount(
        '0x2000000000000000000000000000000000000000000000000000000000000000',
      )
      const entry = channel({
        descriptor: { ...descriptor, authorizedSigner: delegatedAccount.address },
      })

      const plan = planCredential({
        account: Object.assign({}, account, { accessKeyAddress: delegatedAccount.address }),
        entry,
        decimals: 6,
        resolved: challengeContext(),
      })

      expect(plan).toMatchObject({ type: 'voucher', entry })
    })

    test('canSignDescriptor matches root, zero, and delegated authorities', () => {
      const delegatedAuthority = '0x00000000000000000000000000000000000000aa' as Address
      expect(canSignDescriptor(account, descriptor)).toBe(true)
      expect(
        canSignDescriptor(account, {
          ...descriptor,
          authorizedSigner: '0x0000000000000000000000000000000000000000' as Address,
        }),
      ).toBe(true)
      expect(
        canSignDescriptor(account, { ...descriptor, authorizedSigner: delegatedAuthority }),
      ).toBe(false)
      expect(
        canSignDescriptor(Object.assign({}, account, { accessKeyAddress: delegatedAuthority }), {
          ...descriptor,
          authorizedSigner: delegatedAuthority,
        }),
      ).toBe(true)
      const otherPayer = '0x00000000000000000000000000000000000000bb' as Address
      expect(canSignDescriptor(account, { ...descriptor, payer: otherPayer })).toBe(false)
      expect(
        canSignDescriptor(Object.assign({}, account, { accessKeyAddress: delegatedAuthority }), {
          ...descriptor,
          payer: otherPayer,
          authorizedSigner: delegatedAuthority,
        }),
      ).toBe(false)
    })

    test('rejects channel ID reuse without descriptor or cache entry', () => {
      expect(() =>
        planCredential({
          account,
          entry: undefined,
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
          expected: {
            chainId: 42431,
            escrow,
            payee,
            payer: account.address,
            authorizedSigner: account.address,
            token,
          },
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
        {
          name: 'payer',
          parameters: {
            descriptor: {
              ...descriptor,
              payer: '0x0000000000000000000000000000000000000005' as Address,
            },
          },
          message: 'context descriptor payer does not match account',
        },
        {
          name: 'authorizedSigner',
          parameters: {
            descriptor: {
              ...descriptor,
              authorizedSigner: '0x0000000000000000000000000000000000000006' as Address,
            },
          },
          message: 'context descriptor authorizedSigner does not match account',
        },
      ] as const

      for (const item of cases) {
        let reads = 0
        await expect(
          resolveReusableChannel({
            client,
            descriptor,
            expected: {
              chainId: 42431,
              escrow,
              payee,
              payer: account.address,
              authorizedSigner: account.address,
              token,
            },
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
            expected: {
              chainId: 42431,
              escrow,
              payee,
              payer: account.address,
              authorizedSigner: account.address,
              token,
            },
            readChannelState: async () => item.state,
          }),
        ).rejects.toThrow(item.message)
      }
    })
  })
})
