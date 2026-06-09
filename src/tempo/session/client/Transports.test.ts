import { Hex } from 'ox'
import type { Address } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import type { ChannelEntry } from '../client/ChannelOps.js'
import type { SessionContext } from '../client/CredentialState.js'
import {
  createSessionReceipt,
  serializeSessionReceipt,
  tip20ChannelEscrow,
  type ChannelDescriptor,
} from '../precompile/Protocol.js'
import type { SessionSnapshot } from '../Snapshot.js'
import { initialState, type SessionState } from './Runtime.js'
import {
  applyTopUpResult,
  closeHttpSession,
  createActiveSocketSession,
  isExpectedSocketReceipt,
  managementInput,
  postTopUp,
  prepareWebSocketSession,
  readNeedVoucherEventAmounts,
  resolveManualTopUp,
  resolveNeedVoucherContext,
  resolveRetryHttpPaymentContext,
  retryHttpPaymentRequired,
  validateSocketCloseReadyReceipt,
  validateSocketPaymentReceipt,
  webSocketProbeUrl,
  type TempoSessionChallenge,
  type TopUpRequirement,
} from './Transports.js'

describe('HttpManagement', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex
  const salt = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex.Hex
  const expiringNonceHash =
    '0x0000000000000000000000000000000000000000000000000000000000000003' as Hex.Hex
  const token = '0x20c0000000000000000000000000000000000001' as Address
  const payee = '0x0000000000000000000000000000000000000002' as Address

  const descriptor: ChannelDescriptor = {
    payer: '0x0000000000000000000000000000000000000001',
    payee,
    operator: '0x0000000000000000000000000000000000000000',
    token,
    salt,
    authorizedSigner: '0x0000000000000000000000000000000000000001',
    expiringNonceHash,
  }

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 5n,
      deposit: 10n,
      descriptor,
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  function challenge(snapshot?: SessionSnapshot): TempoSessionChallenge {
    return Challenge.from({
      id: 'challenge-1',
      realm: 'example.test',
      method: Constants.Methods.tempo,
      intent: Constants.Intents.session,
      request: {
        amount: '1',
        currency: token,
        recipient: payee,
        decimals: 6,
        unitType: 'request',
        methodDetails: {
          chainId: 4217,
          escrowContract: undefined,
          ...(snapshot && { [Constants.MethodDetailKeys.sessionSnapshot]: snapshot }),
        },
      },
    }) as TempoSessionChallenge
  }

  function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      acceptedCumulative: '5',
      chainId: 4217,
      channelId,
      deposit: '6',
      descriptor,
      escrow: '0x4D50500000000000000000000000000000000000',
      requiredCumulative: '8',
      settled: '0',
      spent: '5',
      units: 5,
      ...overrides,
    }
  }

  function response402(challenge_: TempoSessionChallenge) {
    return new Response(null, {
      status: 402,
      headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge_) },
    })
  }

  function receiptHeader(acceptedCumulative: bigint, spent: bigint) {
    return serializeSessionReceipt(
      createSessionReceipt({ acceptedCumulative, challengeId: 'challenge-1', channelId, spent }),
    )
  }

  function authorizationHeader(init: RequestInit | undefined) {
    const headers = init?.headers as Record<string, string> | undefined
    return headers?.[Constants.Headers.authorization]
  }

  describe('precompile session HTTP management helpers', () => {
    test('converts WebSocket URLs to HTTP probe URLs', () => {
      expect(webSocketProbeUrl('ws://example.test/socket?stream=1').toString()).toBe(
        'http://example.test/socket?stream=1',
      )
      expect(webSocketProbeUrl('wss://example.test/socket?stream=1').toString()).toBe(
        'https://example.test/socket?stream=1',
      )
    })

    test('leaves HTTP URLs unchanged for probe callers', () => {
      expect(webSocketProbeUrl('https://example.test/socket?stream=1').toString()).toBe(
        'https://example.test/socket?stream=1',
      )
    })

    test('strips resource query state from management URLs', () => {
      expect(managementInput('https://example.test/resource?cursor=abc').toString()).toBe(
        'https://example.test/resource',
      )
    })

    test('resolves retry context from a session challenge snapshot and matching channel', () => {
      const entry = channel()
      expect(
        resolveRetryHttpPaymentContext({
          channel: entry,
          response: response402(challenge(snapshot())),
        }),
      ).toMatchObject({
        channel: entry,
        challenge: { id: 'challenge-1' },
        snapshot: { channelId },
      })
    })

    test('does not resolve retry context without snapshot or matching channel', () => {
      expect(
        resolveRetryHttpPaymentContext({
          channel: channel(),
          response: response402(challenge()),
        }),
      ).toBeUndefined()
      expect(
        resolveRetryHttpPaymentContext({
          channel: channel({ channelId: `0x${'99'.repeat(32)}` as Hex.Hex }),
          response: response402(challenge(snapshot())),
        }),
      ).toBeUndefined()
    })

    test('postTopUp sends a top-up credential to the management URL', async () => {
      const createSessionCredential = vi.fn(async (_challenge, context: SessionContext) => {
        expect(context).toMatchObject({
          action: 'topUp',
          channelId,
          descriptor,
          additionalDepositRaw: '3',
        })
        return 'top-up-credential'
      })
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe('https://example.test/resource')
        expect(init?.method).toBe('POST')
        expect(authorizationHeader(init)).toBe('top-up-credential')
        return new Response(null, {
          status: 204,
          headers: { [Constants.Headers.paymentReceipt]: receiptHeader(8n, 5n) },
        })
      })

      const receipt = await postTopUp({
        additionalDeposit: 3n,
        challenge: challenge(),
        channel: channel(),
        channelId,
        createSessionCredential,
        fetch,
        input: 'https://example.test/resource?cursor=abc',
      })

      expect(receipt?.acceptedCumulative).toBe('8')
      expect(createSessionCredential).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
    })

    test('retryHttpPaymentRequired signs the server-required cumulative voucher', async () => {
      let entry = channel({ cumulativeAmount: 5n, deposit: 6n })
      const topUpIfNeeded = vi.fn(async () => {
        entry.deposit = 8n
      })
      const createSessionCredential = vi.fn(async (_challenge, context: SessionContext) => {
        expect(context).toMatchObject({
          action: 'voucher',
          channelId,
          descriptor,
          cumulativeAmountRaw: '8',
        })
        entry.cumulativeAmount = 8n
        return 'voucher-credential'
      })
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(authorizationHeader(init)).toBe('voucher-credential')
        return new Response('ok', { status: 200 })
      })
      const setChallenge = vi.fn()
      const restoreCumulative = vi.fn()

      const retry = await retryHttpPaymentRequired({
        createSessionCredential,
        fetch,
        getChannel: () => entry,
        input: 'https://example.test/resource',
        response: response402(challenge(snapshot())),
        restoreCumulative,
        setChallenge,
        topUpIfNeeded,
      })

      expect(retry?.status).toBe(200)
      expect(setChallenge).toHaveBeenCalledOnce()
      expect(topUpIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ channelId, deposit: 6n, requiredCumulative: 8n }),
      )
      expect(restoreCumulative).not.toHaveBeenCalled()
    })

    test('retryHttpPaymentRequired restores cumulative authorization when retry fails', async () => {
      const entry = channel({ cumulativeAmount: 5n })
      const restoreCumulative = vi.fn()

      await retryHttpPaymentRequired({
        createSessionCredential: async () => 'voucher-credential',
        fetch: async () => new Response('nope', { status: 500 }),
        getChannel: () => entry,
        input: 'https://example.test/resource',
        response: response402(challenge(snapshot())),
        restoreCumulative,
        setChallenge() {},
        topUpIfNeeded: async () => {},
      })

      expect(restoreCumulative).toHaveBeenCalledWith(channelId, 5n)
    })

    test('closeHttpSession posts a close credential and parses the receipt', async () => {
      const entry = channel()
      const createSessionCredential = vi.fn(async (_challenge, context: SessionContext) => {
        expect(context).toMatchObject({
          action: 'close',
          channelId,
          descriptor,
          cumulativeAmountRaw: '5',
        })
        return 'close-credential'
      })

      const receipt = await closeHttpSession({
        createSessionCredential,
        fetch: async (_input, init) => {
          expect(authorizationHeader(init)).toBe('close-credential')
          return new Response(null, {
            status: 200,
            headers: { [Constants.Headers.paymentReceipt]: receiptHeader(5n, 5n) },
          })
        },
        lastUrl: 'https://example.test/resource',
        signedCloseAmount: '5',
        target: { challenge: challenge(), channel: entry, channelId },
      })

      expect(receipt?.spent).toBe('5')
    })

    test('closeHttpSession retries once with a fresh session challenge after 402', async () => {
      const entry = channel()
      const retryChallenge = { ...challenge(), id: 'challenge-2' } as TempoSessionChallenge
      const setChallenge = vi.fn()
      const createSessionCredential = vi.fn(async (challenge_) => {
        return `close-${challenge_.id}`
      })
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response402(retryChallenge))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            headers: { [Constants.Headers.paymentReceipt]: receiptHeader(5n, 5n) },
          }),
        )

      const receipt = await closeHttpSession({
        createSessionCredential,
        fetch,
        lastUrl: 'https://example.test/resource',
        signedCloseAmount: '5',
        setChallenge,
        target: { challenge: challenge(), channel: entry, channelId },
      })

      expect(receipt?.spent).toBe('5')
      expect(setChallenge).toHaveBeenCalledWith(retryChallenge)
      expect(createSessionCredential).toHaveBeenCalledTimes(2)
      expect(createSessionCredential.mock.calls[1]?.[0]).toMatchObject({ id: retryChallenge.id })
      expect(authorizationHeader(fetch.mock.calls[1]?.[1])).toBe('close-challenge-2')
    })

    test('closeHttpSession includes problem detail and challenge header on failure', async () => {
      await expect(
        closeHttpSession({
          createSessionCredential: async () => 'close-credential',
          fetch: async () =>
            new Response(JSON.stringify({ detail: 'invalid close' }), {
              status: 400,
              headers: {
                'Content-Type': 'application/problem+json',
                [Constants.Headers.wwwAuthenticate]: 'Payment id="next"',
              },
            }),
          lastUrl: 'https://example.test/resource',
          signedCloseAmount: '5',
          target: { challenge: challenge(), channel: channel(), channelId },
        }),
      ).rejects.toThrow(
        'Close request failed with status 400: invalid close [WWW-Authenticate: Payment id="next"]',
      )
    })
  })
})

describe('VoucherManagement', () => {
  const channelId = `0x${'11'.repeat(32)}` as Hex.Hex
  const challenge = Challenge.from({
    id: 'challenge-1',
    realm: 'example.test',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x0000000000000000000000000000000000000002',
      decimals: 0,
      unitType: 'request',
      methodDetails: {
        chainId: 4217,
        escrowContract: tip20ChannelEscrow,
      },
    },
  }) as TempoSessionChallenge

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 1n,
      deposit: 10n,
      descriptor: {
        payer: '0x0000000000000000000000000000000000000001' as Address,
        payee: '0x0000000000000000000000000000000000000002' as Address,
        operator: '0x0000000000000000000000000000000000000000' as Address,
        token: '0x20c0000000000000000000000000000000000001' as Address,
        salt: `0x${'22'.repeat(32)}` as Hex.Hex,
        authorizedSigner: '0x0000000000000000000000000000000000000001' as Address,
        expiringNonceHash: `0x${'33'.repeat(32)}` as Hex.Hex,
      },
      escrow: tip20ChannelEscrow,
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  describe('resolveNeedVoucherContext', () => {
    test('reads raw-unit amounts from need-voucher events', () => {
      expect(
        readNeedVoucherEventAmounts({
          channelId,
          acceptedCumulative: '1',
          deposit: '3',
          requiredCumulative: '5',
        }),
      ).toEqual({
        acceptedCumulative: 1n,
        deposit: 3n,
        requiredCumulative: 5n,
      })
    })

    test('tops up when required and returns voucher credential context', async () => {
      const entry = channel({ cumulativeAmount: 1n })
      const topUps: TopUpRequirement[] = []

      const resolution = await resolveNeedVoucherContext({
        assertVoucherWithinLocalLimit: vi.fn(),
        challenge,
        event: {
          channelId,
          requiredCumulative: '5',
          acceptedCumulative: '1',
          deposit: '3',
        },
        expectedChannelId: channelId,
        getChannel: () => entry,
        input: 'https://example.test/stream',
        topUpIfNeeded: async (parameters) => {
          topUps.push(parameters)
        },
      })

      expect(topUps).toEqual([
        {
          challenge,
          input: 'https://example.test/stream',
          channelId,
          deposit: 3n,
          requiredCumulative: 5n,
        },
      ])
      expect(resolution.status).toBe('ready')
      if (resolution.status !== 'ready') throw new Error('expected ready resolution')
      expect(entry.cumulativeAmount).toBe(1n)
      expect(resolution.context).toMatchObject({
        action: 'voucher',
        channelId,
        descriptor: entry.descriptor,
        cumulativeAmountRaw: '5',
      })
    })

    test('preserves higher local cumulative authorization', async () => {
      const entry = channel({ cumulativeAmount: 9n })

      const resolution = await resolveNeedVoucherContext({
        assertVoucherWithinLocalLimit: vi.fn(),
        challenge,
        event: {
          channelId,
          requiredCumulative: '5',
          acceptedCumulative: '1',
          deposit: '10',
        },
        expectedChannelId: channelId,
        getChannel: () => entry,
        input: 'https://example.test/stream',
        topUpIfNeeded: async () => {},
      })

      expect(entry.cumulativeAmount).toBe(9n)
      expect(resolution.status).toBe('ready')
      if (resolution.status !== 'ready') throw new Error('expected ready resolution')
      expect(resolution.context.cumulativeAmountRaw).toBe('9')
    })

    test('ignores need-voucher when the active channel disappears after top-up', async () => {
      const resolution = await resolveNeedVoucherContext({
        assertVoucherWithinLocalLimit: vi.fn(),
        challenge,
        event: {
          channelId,
          requiredCumulative: '5',
          acceptedCumulative: '1',
          deposit: '10',
        },
        expectedChannelId: channelId,
        getChannel: () => null,
        input: 'https://example.test/stream',
        topUpIfNeeded: async () => {},
      })

      expect(resolution).toEqual({ status: 'ignored', reason: 'missing-channel' })
    })

    test('ignores need-voucher events for another channel before top-up', async () => {
      const topUpIfNeeded = vi.fn()

      const resolution = await resolveNeedVoucherContext({
        assertVoucherWithinLocalLimit: vi.fn(),
        challenge,
        event: {
          channelId: `0x${'44'.repeat(32)}` as Hex.Hex,
          requiredCumulative: '5',
          acceptedCumulative: '1',
          deposit: '10',
        },
        expectedChannelId: channelId,
        getChannel: () => channel(),
        input: 'https://example.test/stream',
        topUpIfNeeded,
      })

      expect(resolution).toEqual({ status: 'ignored', reason: 'channel-mismatch' })
      expect(topUpIfNeeded).not.toHaveBeenCalled()
    })
  })

  describe('resolveManualTopUp', () => {
    test('returns a typed top-up target for an active manager session', () => {
      const assertLimit = vi.fn()

      const target = resolveManualTopUp({
        amount: '1',
        assertVoucherWithinLocalLimit: assertLimit,
        channel: channel({ cumulativeAmount: 1_000_000n, deposit: 1_000_000n }),
        decimals: 6,
        lastChallenge: challenge,
        lastUrl: 'https://api.example.com/data',
      })

      expect(target).toEqual({
        additionalDeposit: 1_000_000n,
        challenge,
        channelId,
        input: 'https://api.example.com/data',
      })
      expect(assertLimit).toHaveBeenCalledWith(2_000_000n)
    })

    test('rejects manual top-up when no channel is open or amount is non-positive', () => {
      expect(() =>
        resolveManualTopUp({
          amount: '1',
          assertVoucherWithinLocalLimit: vi.fn(),
          channel: channel({ opened: false }),
          decimals: 6,
          lastChallenge: challenge,
          lastUrl: 'https://api.example.com/data',
        }),
      ).toThrow('Cannot top up session: no open channel.')

      expect(() =>
        resolveManualTopUp({
          amount: 0n,
          assertVoucherWithinLocalLimit: vi.fn(),
          channel: channel(),
          decimals: 6,
          lastChallenge: challenge,
          lastUrl: 'https://api.example.com/data',
        }),
      ).toThrow('Top-up amount must be greater than zero.')
    })
  })

  function activeState(entry: ChannelEntry): SessionState {
    return {
      status: 'active',
      acceptedCumulative: entry.cumulativeAmount.toString(),
      challengeId: 'challenge-1',
      channelId: entry.channelId,
      deposit: entry.deposit.toString(),
      descriptor: entry.descriptor,
      spent: '40',
      units: 3,
    }
  }

  describe('applyTopUpResult', () => {
    test('adds top-up deposit without replacing it with accepted cumulative receipt value', () => {
      const entry = channel({ cumulativeAmount: 100n, deposit: 500n })
      const result = applyTopUpResult({
        additionalDeposit: 200n,
        channel: entry,
        channelId,
        currentState: activeState(entry),
        receipt: createSessionReceipt({
          acceptedCumulative: 100n,
          challengeId: 'challenge-1',
          channelId,
          spent: 80n,
          units: 4,
        }),
        spent: 40n,
      })

      expect(result?.channel.deposit).toBe(700n)
      expect(result?.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '100',
        deposit: '700',
        spent: '80',
        units: 4,
      })
    })

    test('projects active state without a receipt and preserves active units', () => {
      const entry = channel({ cumulativeAmount: 100n, deposit: 500n })
      const result = applyTopUpResult({
        additionalDeposit: 50n,
        channel: entry,
        channelId,
        challengeId: 'challenge-2',
        currentState: activeState(entry),
        spent: 40n,
      })

      expect(result?.channel.deposit).toBe(550n)
      expect(result?.state).toMatchObject({
        status: 'active',
        challengeId: 'challenge-2',
        deposit: '550',
        spent: '40',
        units: 3,
      })
    })

    test('ignores top-ups for a different channel', () => {
      const entry = channel({ deposit: 500n })
      const result = applyTopUpResult({
        additionalDeposit: 50n,
        channel: entry,
        channelId: `0x${'55'.repeat(32)}` as Hex.Hex,
        currentState: initialState,
        spent: 0n,
      })

      expect(result).toBeUndefined()
      expect(entry.deposit).toBe(500n)
    })
  })
})

describe('WsDriver', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex
  const challenge: TempoSessionChallenge = {
    id: 'challenge-1',
    realm: 'test',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '25',
      currency: 'pathUSD',
      methodDetails: { escrowContract: undefined },
      recipient: 'payee',
      unitType: 'chunk',
    },
  }

  function receipt(overrides: Partial<Parameters<typeof createSessionReceipt>[0]> = {}) {
    const parameters = {
      acceptedCumulative: 80n,
      challengeId: 'challenge-1',
      channelId,
      spent: 80n,
      ...overrides,
    }
    return createSessionReceipt(parameters)
  }

  describe('WsDriver socket state', () => {
    test('hydrates socket runtime state from the opening credential', () => {
      const socket = {} as WebSocket
      const credential = Credential.serialize({
        challenge,
        payload: { action: 'open', channelId },
      })

      expect(createActiveSocketSession({ challenge, credential, socket })).toEqual({
        challenge,
        channelId,
        closeReadyReceipt: null,
        deliveredChunks: 0n,
        expectedCloseAmount: null,
        socket,
        tickCost: 25n,
      })
    })
  })

  describe('WsDriver receipt validation', () => {
    test('matches receipts to active socket challenge and channel', () => {
      expect(
        isExpectedSocketReceipt({
          challengeId: 'challenge-1',
          channelId,
          receipt: receipt(),
        }),
      ).toBe(true)

      expect(
        isExpectedSocketReceipt({
          challengeId: 'challenge-2',
          channelId,
          receipt: receipt(),
        }),
      ).toBe(false)
    })

    test('validates close-ready receipts against local cumulative authorization', () => {
      expect(
        validateSocketCloseReadyReceipt({
          challengeId: 'challenge-1',
          channelId,
          cumulativeAmount: 80n,
          receipt: receipt(),
        }),
      ).toBeUndefined()

      expect(
        validateSocketCloseReadyReceipt({
          challengeId: 'challenge-1',
          channelId,
          cumulativeAmount: 79n,
          receipt: receipt(),
        }),
      ).toBe('received payment-close-ready beyond local voucher state')
    })

    test('validates final close receipts when a close amount is expected', () => {
      expect(
        validateSocketPaymentReceipt({
          challengeId: 'challenge-1',
          channelId,
          expectedCloseAmount: '80',
          receipt: receipt({ txHash: '0x1234' }),
        }),
      ).toBeUndefined()

      expect(
        validateSocketPaymentReceipt({
          challengeId: 'challenge-1',
          channelId,
          expectedCloseAmount: '81',
          receipt: receipt({ txHash: '0x1234' }),
        }),
      ).toBe('received mismatched payment-close receipt frame')
    })
  })

  function makeChallenge(overrides: Partial<Challenge.Challenge> = {}): Challenge.Challenge {
    return Challenge.from({
      id: 'test-challenge',
      realm: 'test.example.com',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '1000000',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
        methodDetails: {
          chainId: 4217,
          escrowContract: tip20ChannelEscrow,
        },
        recipient: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
      },
      ...overrides,
    })
  }

  function make402Response(challenge: Challenge.Challenge): Response {
    return new Response(null, {
      status: 402,
      headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) },
    })
  }

  describe('prepareWebSocketSession', () => {
    test('probes the HTTP URL, selects the tempo session challenge, and creates the opening credential', async () => {
      const challenge = makeChallenge()
      const events: string[] = []
      const fetch = async (input: RequestInfo | URL) => {
        events.push(`fetch:${input.toString()}`)
        return make402Response(challenge)
      }

      const prepared = await prepareWebSocketSession({
        async createSessionCredential(selected, context) {
          events.push(`credential:${selected.id}:${Object.keys(context).length}`)
          expect(selected).toEqual(challenge)
          expect(context).toEqual({})
          return 'Payment credential'
        },
        fetch,
        input: 'wss://example.test/socket?stream=1',
        onProbeUrl(url) {
          events.push(`probe:${url.toString()}`)
        },
      })

      expect(prepared).toEqual({
        challenge,
        credential: 'Payment credential',
        httpUrl: new URL('https://example.test/socket?stream=1'),
        wsUrl: new URL('wss://example.test/socket?stream=1'),
      })
      expect(events).toEqual([
        'probe:https://example.test/socket?stream=1',
        'fetch:https://example.test/socket?stream=1',
        'credential:test-challenge:0',
      ])
    })

    test('throws when the HTTP probe does not return a payment challenge', async () => {
      await expect(
        prepareWebSocketSession({
          createSessionCredential: async () => 'unused',
          fetch: async () => new Response(null, { status: 200 }),
          input: 'ws://example.test/socket',
        }),
      ).rejects.toThrow(
        'Expected a 402 payment challenge from http://example.test/socket, received 200 instead.',
      )
    })

    test('throws when the probe does not advertise a tempo session challenge', async () => {
      await expect(
        prepareWebSocketSession({
          createSessionCredential: async () => 'unused',
          fetch: async () => make402Response(makeChallenge({ intent: 'charge' })),
          input: 'ws://example.test/socket',
        }),
      ).rejects.toThrow(
        'No payment challenge received from HTTP endpoint for this WebSocket URL. The server may not require payment or did not advertise a challenge.',
      )
    })
  })
})
