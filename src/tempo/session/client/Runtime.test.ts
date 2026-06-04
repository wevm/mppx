import { Hex } from 'ox'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import type { ChannelEntry } from '../client/ChannelOps.js'
import type { SessionContext } from '../client/CredentialState.js'
import * as Ws from '../precompile/Protocol.js'
import {
  createSessionReceipt,
  type ChannelDescriptor,
  type SessionReceipt,
} from '../precompile/Protocol.js'
import { createSessionReceiptCoordinator } from './ReceiptCoordinator.js'
import {
  activeStateFromChannel,
  activeStateFromReceipt,
  applySessionReceiptToRuntime,
  assertCloseReadyWithinLocalState,
  assertReceiptWithinLocalState,
  assertVoucherWithinLocalLimit,
  assertWithinMaxDeposit,
  captureRuntimeSnapshot,
  closedStateFromReceipt,
  closeSocketSession,
  createActiveState,
  createSessionManagerRuntime,
  initialState,
  isExpectedCloseReceipt,
  localCloseSpendLimit,
  nextSpentFromReceipt,
  parseManagerAmount,
  reduce,
  resolveCloseTarget,
  resolveNeedVoucherTransition,
  resolveOpeningDeposit,
  restoreCumulativeAuthorization,
  restoreRuntimeSnapshot,
  type CloseTarget,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from './Runtime.js'
import {
  WebSocketReadyState,
  type ActiveSocketSession,
  type TempoSessionChallenge,
} from './Transports.js'

describe('Machine', () => {
  const descriptor = {
    authorizedSigner: '0x0000000000000000000000000000000000000006',
    expiringNonceHash: `0x${'11'.repeat(32)}`,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000002',
    payer: '0x0000000000000000000000000000000000000001',
    salt: `0x${'22'.repeat(32)}`,
    token: '0x0000000000000000000000000000000000000003',
  } as const satisfies ChannelDescriptor

  const channelId = `0x${'33'.repeat(32)}` as const

  const snapshot = {
    acceptedCumulative: '5',
    channelId,
    deposit: '10',
    descriptor,
    requiredCumulative: '6',
    settled: '0',
    spent: '2',
    units: 2,
  } satisfies SessionSnapshot

  const receipt = {
    acceptedCumulative: '5',
    challengeId: 'challenge-1',
    channelId,
    intent: 'session',
    method: 'tempo',
    reference: channelId,
    spent: '5',
    status: 'success',
    timestamp: new Date(0).toISOString(),
  } as const

  const states = {
    idle: initialState,
    challenged: { status: 'challenged', challengeId: 'challenge-1' },
    hydrating: { status: 'hydrating', challengeId: 'challenge-1', snapshot },
    opening: { status: 'opening', challengeId: 'challenge-1' },
    active: createActiveState({
      challengeId: 'challenge-1',
      channelId,
      descriptor,
      acceptedCumulative: '5',
      deposit: '10',
      spent: '5',
      units: 1,
    }),
    voucherNeeded: {
      status: 'voucherNeeded',
      challengeId: 'challenge-1',
      channelId,
      descriptor,
      requiredCumulative: '7',
      deposit: '10',
    },
    toppingUp: {
      status: 'toppingUp',
      challengeId: 'challenge-1',
      channelId,
      descriptor,
      deposit: '10',
    },
    settling: { status: 'settling', channelId, descriptor, deposit: '10' },
    closeRequested: { status: 'closeRequested', channelId, descriptor },
    withdrawable: { status: 'withdrawable', channelId, descriptor },
    closing: { status: 'closing', channelId, descriptor },
    closed: { status: 'closed', channelId, descriptor },
  } satisfies Record<SessionState['status'], SessionState>

  const events = {
    challenge: { type: 'challenge', challengeId: 'challenge-2' },
    hydrated: { type: 'hydrated', snapshot },
    opened: { type: 'opened', descriptor, receipt, deposit: '10' },
    needVoucher: {
      type: 'needVoucher',
      descriptor,
      event: {
        acceptedCumulative: '5',
        channelId,
        deposit: '10',
        requiredCumulative: '7',
      },
    },
    topUpStarted: { type: 'topUpStarted' },
    voucherAccepted: { type: 'voucherAccepted', receipt },
    settleStarted: { type: 'settleStarted' },
    settled: { type: 'settled', receipt },
    closeRequested: { type: 'closeRequested' },
    withdrawable: { type: 'withdrawable' },
    closeStarted: { type: 'closeStarted' },
    closed: { type: 'closed', receipt },
  } satisfies Record<SessionEvent['type'], SessionEvent>

  const allowedEvents = {
    idle: ['challenge'],
    challenged: [],
    hydrating: ['hydrated'],
    opening: ['opened'],
    active: ['challenge', 'needVoucher', 'settleStarted', 'closeRequested', 'closeStarted'],
    voucherNeeded: ['topUpStarted', 'voucherAccepted'],
    toppingUp: ['voucherAccepted'],
    settling: ['settled'],
    closeRequested: ['withdrawable'],
    withdrawable: ['closeStarted', 'closed'],
    closing: ['closed'],
    closed: [],
  } satisfies Record<SessionState['status'], readonly SessionEvent['type'][]>

  describe('precompile session state machine', () => {
    test('only allows documented state/event transitions', () => {
      for (const [status, state] of Object.entries(states)) {
        const allowed = new Set(allowedEvents[status as SessionState['status']])

        for (const [eventType, event] of Object.entries(events)) {
          const transition = () => reduce(state, event)

          if (allowed.has(eventType as SessionEvent['type'])) {
            expect(transition).not.toThrow()
          } else {
            expect(transition).toThrow(`Invalid session transition: ${status} + ${eventType}`)
          }
        }
      }
    })

    test('hydrates from a server snapshot', () => {
      const challenged = reduce(initialState, {
        type: 'challenge',
        challengeId: 'challenge-1',
        snapshot,
      })

      expect(challenged.state.status).toBe('hydrating')
      expect(challenged.effects).toEqual([{ type: 'hydrate', snapshot }])

      const hydrated = reduce(challenged.state, { type: 'hydrated', snapshot })
      expect(hydrated.effects).toEqual([])
      expect(hydrated.state).toEqual({
        status: 'active',
        challengeId: 'challenge-1',
        channelId,
        descriptor,
        acceptedCumulative: '5',
        deposit: '10',
        spent: '2',
        units: 2,
      })
    })

    test('opens when no snapshot exists', () => {
      const next = reduce(initialState, { type: 'challenge', challengeId: 'challenge-1' })

      expect(next.state).toEqual({ status: 'opening', challengeId: 'challenge-1' })
      expect(next.effects).toEqual([{ type: 'open' }])
    })

    test('keeps deposit separate from accepted cumulative after open receipts', () => {
      const opening = reduce(initialState, { type: 'challenge', challengeId: 'challenge-1' })
      const opened = reduce(opening.state, {
        type: 'opened',
        descriptor,
        deposit: '10',
        receipt: {
          acceptedCumulative: '5',
          challengeId: 'challenge-1',
          channelId,
          intent: 'session',
          method: 'tempo',
          reference: channelId,
          spent: '5',
          status: 'success',
          timestamp: new Date(0).toISOString(),
        },
      })

      expect(opened.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '5',
        deposit: '10',
        spent: '5',
      })
    })

    test('requests top-up before voucher when required cumulative exceeds deposit', () => {
      const active = reduce(
        reduce(initialState, { type: 'challenge', challengeId: 'challenge-1', snapshot }).state,
        { type: 'hydrated', snapshot },
      ).state

      const next = reduce(active, {
        type: 'needVoucher',
        descriptor,
        event: {
          acceptedCumulative: '5',
          channelId,
          deposit: '10',
          requiredCumulative: '12',
        },
      })

      expect(next.state).toEqual({
        status: 'toppingUp',
        challengeId: 'challenge-1',
        channelId,
        descriptor,
        deposit: '10',
      })
      expect(next.effects).toEqual([{ type: 'topUp', channelId, amount: '2' }])
    })

    test('plans voucher-only need-voucher transitions when deposit has headroom', () => {
      expect(
        resolveNeedVoucherTransition({
          challengeId: 'challenge-1',
          descriptor,
          event: {
            acceptedCumulative: '5',
            channelId,
            deposit: '10',
            requiredCumulative: '7',
          },
        }),
      ).toEqual({
        state: {
          status: 'voucherNeeded',
          challengeId: 'challenge-1',
          channelId,
          descriptor,
          requiredCumulative: '7',
          deposit: '10',
        },
        effects: [{ type: 'voucher' }],
      })
    })

    test('preserves deposit after settlement receipts', () => {
      const active = reduce(
        reduce(initialState, { type: 'challenge', challengeId: 'challenge-1', snapshot }).state,
        { type: 'hydrated', snapshot },
      ).state
      const settling = reduce(active, { type: 'settleStarted' })
      const settled = reduce(settling.state, {
        type: 'settled',
        receipt: {
          acceptedCumulative: '5',
          challengeId: 'challenge-1',
          channelId,
          intent: 'session',
          method: 'tempo',
          reference: channelId,
          spent: '5',
          status: 'success',
          timestamp: new Date(0).toISOString(),
        },
      })

      expect(settled.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '5',
        deposit: '10',
        spent: '5',
      })
    })

    test('rejects invalid transitions', () => {
      expect(() =>
        reduce(initialState, {
          type: 'voucherAccepted',
          receipt: {
            acceptedCumulative: '1',
            challengeId: 'challenge-1',
            channelId,
            intent: 'session',
            method: 'tempo',
            reference: channelId,
            spent: '1',
            status: 'success',
            timestamp: new Date(0).toISOString(),
          },
        }),
      ).toThrow('Invalid session transition')
    })
  })
})

describe('RuntimeState', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex
  const salt = '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex.Hex
  const expiringNonceHash =
    '0x0000000000000000000000000000000000000000000000000000000000000003' as Hex.Hex

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
        salt,
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash,
      },
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  describe('RuntimeState', () => {
    test('projects cached channel data into active machine state', () => {
      const entry = channel({ cumulativeAmount: 12n, deposit: 30n })

      expect(
        activeStateFromChannel({
          challengeId: 'challenge-1',
          entry,
          spent: '7',
          units: 2,
        }),
      ).toEqual({
        status: 'active',
        challengeId: 'challenge-1',
        channelId: entry.channelId,
        descriptor: entry.descriptor,
        acceptedCumulative: '12',
        deposit: '30',
        spent: '7',
        units: 2,
      })
    })

    test('projects receipts without replacing the local deposit boundary', () => {
      const entry = channel({ deposit: 30n })
      const receipt = createSessionReceipt({
        acceptedCumulative: 12n,
        challengeId: 'challenge-1',
        channelId: entry.channelId,
        spent: 8n,
        units: 3,
      })

      expect(activeStateFromReceipt(receipt, entry)).toMatchObject({
        acceptedCumulative: '12',
        deposit: '30',
        spent: '8',
        units: 3,
      })
    })

    test('projects final close receipts into closed machine state', () => {
      const entry = channel()
      const receipt = createSessionReceipt({
        acceptedCumulative: 12n,
        challengeId: 'challenge-1',
        channelId: entry.channelId,
        spent: 8n,
        txHash: '0x1234',
      })

      expect(closedStateFromReceipt(receipt, entry)).toEqual({
        status: 'closed',
        channelId: entry.channelId,
        descriptor: entry.descriptor,
      })
    })

    test('restores mutable channel fields from a snapshot', () => {
      const entry = channel({ cumulativeAmount: 12n, deposit: 30n, opened: true })
      const snapshot = captureRuntimeSnapshot({ channel: entry, spent: 4n, state: initialState })

      entry.cumulativeAmount = 99n
      entry.deposit = 100n
      entry.opened = false

      const restored = restoreRuntimeSnapshot(snapshot, entry)

      expect(restored).toEqual({ channel: entry, spent: 4n, state: initialState })
      expect(entry.cumulativeAmount).toBe(12n)
      expect(entry.deposit).toBe(30n)
      expect(entry.opened).toBe(true)
    })

    test('restores a null channel snapshot and marks the current channel closed', () => {
      const current = channel({ opened: true })
      const snapshot = captureRuntimeSnapshot({ channel: null, spent: 0n, state: initialState })

      const restored = restoreRuntimeSnapshot(snapshot, current)

      expect(restored).toEqual({ channel: null, spent: 0n, state: initialState })
      expect(current.opened).toBe(false)
    })

    test('restores cumulative authorization and returns refreshed active state', () => {
      const entry = channel({ cumulativeAmount: 99n, deposit: 150n })

      const state = restoreCumulativeAuthorization({
        channel: entry,
        channelId: entry.channelId,
        challengeId: 'challenge-1',
        cumulativeAmount: 20n,
        spent: 7n,
        state: activeStateFromChannel({
          challengeId: 'challenge-1',
          entry,
          spent: '7',
          units: 4,
        }),
      })

      expect(entry.cumulativeAmount).toBe(20n)
      expect(state).toMatchObject({
        status: 'active',
        acceptedCumulative: '20',
        deposit: '150',
        spent: '7',
        units: 4,
      })
    })

    test('does not restore cumulative authorization for a different channel', () => {
      const entry = channel({ cumulativeAmount: 99n })

      const state = restoreCumulativeAuthorization({
        channel: entry,
        channelId: '0x0000000000000000000000000000000000000000000000000000000000000099' as Hex.Hex,
        challengeId: 'challenge-1',
        cumulativeAmount: 20n,
        spent: 7n,
        state: initialState,
      })

      expect(entry.cumulativeAmount).toBe(99n)
      expect(state).toBeUndefined()
    })

    test('creates idle mutable runtime state for a new manager', () => {
      expect(createSessionManagerRuntime()).toEqual({
        channel: null,
        lastChallenge: null,
        lastUrl: null,
        spent: 0n,
        socketSession: null,
        state: { status: 'idle' },
      })
    })

    test('applies matching receipts to spent and public active state', () => {
      const runtime = createSessionManagerRuntime()
      runtime.channel = channel({ cumulativeAmount: 100n, deposit: 150n })
      runtime.spent = 10n

      applySessionReceiptToRuntime({
        maxVoucherCumulative: null,
        receipt: createSessionReceipt({
          acceptedCumulative: 100n,
          challengeId: 'challenge-1',
          channelId,
          spent: 20n,
          units: 3,
        }),
        runtime,
      })

      expect(runtime.spent).toBe(20n)
      expect(runtime.state).toMatchObject({
        status: 'active',
        challengeId: 'challenge-1',
        channelId,
        acceptedCumulative: '100',
        deposit: '150',
        spent: '20',
        units: 3,
      })
    })

    test('ignores receipts for other channels', () => {
      const runtime = createSessionManagerRuntime()
      runtime.channel = channel({ cumulativeAmount: 100n, deposit: 150n })
      runtime.spent = 10n

      applySessionReceiptToRuntime({
        maxVoucherCumulative: null,
        receipt: createSessionReceipt({
          acceptedCumulative: 100n,
          challengeId: 'challenge-1',
          channelId: `0x${'02'.repeat(32)}` as Hex.Hex,
          spent: 20n,
        }),
        runtime,
      })

      expect(runtime.spent).toBe(10n)
      expect(runtime.state).toEqual({ status: 'idle' })
    })
  })
})

describe('SessionReceiptCoordinator', () => {
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

  function receipt(spent: bigint) {
    return createSessionReceipt({
      acceptedCumulative: spent,
      challengeId: challenge.id,
      channelId,
      spent,
    })
  }

  function socketSession(overrides: Partial<ActiveSocketSession> = {}): ActiveSocketSession {
    return {
      challenge,
      channelId,
      closeReadyReceipt: null,
      deliveredChunks: 0n,
      expectedCloseAmount: null,
      socket: null,
      tickCost: 25n,
      ...overrides,
    }
  }

  describe('SessionReceiptCoordinator', () => {
    test('waits for the receipt accepted by the predicate', async () => {
      const coordinator = createSessionReceiptCoordinator({ getSocketSession: () => null })
      const expected = receipt(2n)
      const wait = coordinator.waitForReceipt((candidate) => candidate.spent === expected.spent)

      coordinator.settleReceipt(receipt(1n))
      coordinator.settleReceipt(expected)

      await expect(wait).resolves.toBe(expected)
    })

    test('caches matching close-ready receipts on the active socket session', async () => {
      const currentSocket = socketSession()
      const coordinator = createSessionReceiptCoordinator({
        getSocketSession: () => currentSocket,
      })
      const closeReady = receipt(3n)

      coordinator.settleCloseReady(closeReady)

      expect(currentSocket.closeReadyReceipt).toBe(closeReady)
      await expect(coordinator.waitForCloseReady()).resolves.toBe(closeReady)
    })

    test('rejects pending waits', async () => {
      const coordinator = createSessionReceiptCoordinator({ getSocketSession: () => null })
      const wait = coordinator.waitForReceipt()
      const error = new Error('failed')

      coordinator.rejectReceipt(error)

      await expect(wait).rejects.toBe(error)
    })
  })
})

describe('CloseAuthorization', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex

  function challenge(id = 'challenge-1'): TempoSessionChallenge {
    return Challenge.from({
      id,
      method: 'tempo',
      intent: 'session',
      realm: 'test',
      request: {
        amount: '1',
        currency: '0x20c0000000000000000000000000000000000001',
        recipient: '0x0000000000000000000000000000000000000002',
        methodDetails: { chainId: 4217 },
      },
    }) as TempoSessionChallenge
  }

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 100n,
      deposit: 150n,
      descriptor: {
        payer: '0x0000000000000000000000000000000000000001',
        payee: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000000',
        token: '0x20c0000000000000000000000000000000000001',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000002',
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash: '0x0000000000000000000000000000000000000000000000000000000000000003',
      },
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  describe('CloseAuthorization', () => {
    test('returns undefined when no local channel is open', () => {
      expect(
        resolveCloseTarget({
          channel: channel({ opened: false }),
          currentSocket: null,
          lastChallenge: challenge(),
        }),
      ).toBeUndefined()
    })

    test('resolves HTTP close target from local channel and last challenge', () => {
      const target = resolveCloseTarget({
        channel: channel(),
        currentSocket: null,
        lastChallenge: challenge(),
      })

      expect(target).toMatchObject({ channelId, challenge: { id: 'challenge-1' } })
    })

    test('requires a challenge for an open channel', () => {
      expect(() =>
        resolveCloseTarget({
          channel: channel(),
          currentSocket: null,
          lastChallenge: null,
        }),
      ).toThrow('Cannot close session: no challenge available.')
    })

    test('rejects close-ready spend beyond local voucher state', () => {
      expect(localCloseSpendLimit({ cumulativeAmount: 100n, spent: 80n })).toBe(100n)
      expect(localCloseSpendLimit({ cumulativeAmount: 70n, spent: 80n })).toBe(80n)

      expect(() =>
        assertCloseReadyWithinLocalState({
          cumulativeAmount: 100n,
          readySpent: 101n,
          spent: 80n,
        }),
      ).toThrow('close-ready spent exceeds local voucher state')
    })

    test('matches only final close receipts with txHash and exact amounts', () => {
      const receipt = createSessionReceipt({
        acceptedCumulative: 80n,
        challengeId: 'challenge-1',
        channelId,
        spent: 80n,
        txHash: '0x1234',
      })

      expect(
        isExpectedCloseReceipt({
          challengeId: 'challenge-1',
          channelId,
          expectedCloseAmount: '80',
          receipt,
        }),
      ).toBe(true)
      expect(
        isExpectedCloseReceipt({
          challengeId: 'challenge-1',
          channelId,
          expectedCloseAmount: '81',
          receipt,
        }),
      ).toBe(false)
    })
  })
})

describe('LocalAuthorization', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 100n,
      deposit: 150n,
      descriptor: {
        payer: '0x0000000000000000000000000000000000000001',
        payee: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000000',
        token: '0x20c0000000000000000000000000000000000001',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000002',
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash: '0x0000000000000000000000000000000000000000000000000000000000000003',
      },
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  describe('LocalAuthorization', () => {
    test('accepts receipts within local cumulative authorization', () => {
      expect(() =>
        assertReceiptWithinLocalState({
          channel: channel({ cumulativeAmount: 100n }),
          maxVoucherCumulative: 100n,
          receipt: createSessionReceipt({
            acceptedCumulative: 100n,
            challengeId: 'challenge-1',
            channelId,
            spent: 80n,
          }),
        }),
      ).not.toThrow()
    })

    test('rejects receipts that exceed local cumulative authorization', () => {
      expect(() =>
        assertReceiptWithinLocalState({
          channel: channel({ cumulativeAmount: 100n }),
          maxVoucherCumulative: null,
          receipt: createSessionReceipt({
            acceptedCumulative: 101n,
            challengeId: 'challenge-1',
            channelId,
            spent: 80n,
          }),
        }),
      ).toThrow('receipt accepted cumulative exceeds local voucher state')
    })

    test('rejects receipt spent above accepted cumulative', () => {
      expect(() =>
        assertReceiptWithinLocalState({
          channel: channel({ cumulativeAmount: 100n }),
          maxVoucherCumulative: null,
          receipt: createSessionReceipt({
            acceptedCumulative: 90n,
            challengeId: 'challenge-1',
            channelId,
            spent: 91n,
          }),
        }),
      ).toThrow('receipt spent exceeds accepted cumulative voucher amount')
    })

    test('keeps locally observed spend monotonic', () => {
      expect(
        nextSpentFromReceipt({
          channel: channel(),
          maxVoucherCumulative: null,
          receipt: createSessionReceipt({
            acceptedCumulative: 100n,
            challengeId: 'challenge-1',
            channelId,
            spent: 80n,
          }),
          spent: 90n,
        }),
      ).toBe(90n)
    })

    test('ignores receipts for other channels', () => {
      expect(
        nextSpentFromReceipt({
          channel: channel(),
          maxVoucherCumulative: null,
          receipt: createSessionReceipt({
            acceptedCumulative: 100n,
            challengeId: 'challenge-1',
            channelId: `0x${'04'.repeat(32)}` as Hex.Hex,
            spent: 80n,
          }),
          spent: 10n,
        }),
      ).toBe(10n)
    })

    test('enforces optional maxDeposit authorization cap', () => {
      expect(() =>
        assertVoucherWithinLocalLimit({ cumulativeAmount: 101n, maxVoucherCumulative: 100n }),
      ).toThrow('requested voucher amount 101 exceeds local maxDeposit 100')
    })

    test('resolves opening deposits from explicit context, server hints, request amount, and local cap', () => {
      expect(
        resolveOpeningDeposit({
          contextDepositRaw: '500',
          maxDeposit: 100n,
          requestAmount: 10n,
          suggestedDepositRaw: '1000',
        }),
      ).toBe(500n)
      expect(() =>
        resolveOpeningDeposit({
          contextDepositRaw: '0',
          maxDeposit: 100n,
          requestAmount: 10n,
          suggestedDepositRaw: '1000',
        }),
      ).toThrow('opening deposit 0 below request amount 10')
      expect(
        resolveOpeningDeposit({
          maxDeposit: 500n,
          requestAmount: 100n,
          suggestedDepositRaw: '1000',
        }),
      ).toBe(500n)
      expect(
        resolveOpeningDeposit({
          maxDeposit: 500n,
          requestAmount: 100n,
          suggestedDepositRaw: '50',
        }),
      ).toBe(100n)
      expect(resolveOpeningDeposit({ maxDeposit: 1000n, requestAmount: 100n })).toBe(100n)
      expect(() => resolveOpeningDeposit({ maxDeposit: 50n, requestAmount: 100n })).toThrow(
        'requested voucher amount 100 exceeds local maxDeposit 50',
      )
    })

    test('enforces optional maxDeposit through the compatibility helper', () => {
      expect(() => assertWithinMaxDeposit(101n, 100n)).toThrow(
        'requested voucher amount 101 exceeds local maxDeposit 100',
      )
      expect(() => assertWithinMaxDeposit(100n, 100n)).not.toThrow()
      expect(() => assertWithinMaxDeposit(101n, undefined)).not.toThrow()
    })

    test('parses manager amounts from raw bigint or human-readable string', () => {
      expect(parseManagerAmount(5n, 6)).toBe(5n)
      expect(parseManagerAmount('1.25', 6)).toBe(1_250_000n)
    })
  })
})

describe('SocketClose', () => {
  const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex

  function challenge(id = 'challenge-1'): TempoSessionChallenge {
    return Challenge.from({
      id,
      method: 'tempo',
      intent: 'session',
      realm: 'test',
      request: {
        amount: '10',
        currency: '0x20c0000000000000000000000000000000000001',
        recipient: '0x0000000000000000000000000000000000000002',
        methodDetails: { chainId: 4217 },
      },
    }) as TempoSessionChallenge
  }

  function channel(overrides: Partial<ChannelEntry> = {}): ChannelEntry {
    return {
      channelId,
      cumulativeAmount: 100n,
      deposit: 100n,
      descriptor: {
        payer: '0x0000000000000000000000000000000000000001',
        payee: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000000',
        token: '0x20c0000000000000000000000000000000000001',
        salt: '0x0000000000000000000000000000000000000000000000000000000000000002',
        authorizedSigner: '0x0000000000000000000000000000000000000001',
        expiringNonceHash: '0x0000000000000000000000000000000000000000000000000000000000000003',
      },
      escrow: '0x4D50500000000000000000000000000000000000',
      chainId: 4217,
      opened: true,
      ...overrides,
    }
  }

  function target(overrides: Partial<CloseTarget> = {}): CloseTarget {
    const c = channel()
    return { challenge: challenge(), channel: c, channelId: c.channelId, ...overrides }
  }

  function receipt(spent: bigint, withTx = false): SessionReceipt {
    return createSessionReceipt({
      acceptedCumulative: spent,
      challengeId: 'challenge-1',
      channelId,
      spent,
      ...(withTx ? { txHash: '0x1234' } : {}),
    })
  }

  function socketSession(overrides: Partial<ActiveSocketSession> = {}): ActiveSocketSession {
    return {
      challenge: challenge(),
      channelId,
      closeReadyReceipt: null,
      deliveredChunks: 0n,
      expectedCloseAmount: null,
      socket: null,
      tickCost: 10n,
      ...overrides,
    }
  }

  function socket() {
    return {
      close: vi.fn(),
      readyState: WebSocketReadyState.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
  }

  describe('SocketClose', () => {
    test('requests close-ready, signs that spend, and waits for the final receipt', async () => {
      const activeSocket = socket()
      const closeReady = receipt(60n)
      const finalReceipt = receipt(60n, true)
      const createSessionCredential = vi.fn(
        async (_challenge: TempoSessionChallenge, context: SessionContext) => {
          expect(context).toMatchObject({ action: 'close', cumulativeAmountRaw: '60' })
          return 'close-credential'
        },
      )
      const currentSocket = socketSession()

      const result = await closeSocketSession({
        activeSocket,
        createSessionCredential,
        currentSocket,
        spent: 50n,
        target: target(),
        waitForCloseReady: async () => closeReady,
        waitForReceipt: async (predicate) => {
          expect(currentSocket.expectedCloseAmount).toBe('60')
          expect(predicate(finalReceipt)).toBe(true)
          return finalReceipt
        },
      })

      expect(result).toBe(finalReceipt)
      expect(activeSocket.send).toHaveBeenNthCalledWith(1, Ws.formatCloseRequestMessage())
      expect(activeSocket.send).toHaveBeenNthCalledWith(
        2,
        Ws.formatAuthorizationMessage('close-credential'),
      )
      expect(activeSocket.close).toHaveBeenCalledOnce()
      expect(currentSocket.expectedCloseAmount).toBeNull()
    })

    test('uses an existing close-ready receipt without sending a close request', async () => {
      const activeSocket = socket()
      const finalReceipt = receipt(40n, true)
      const currentSocket = socketSession({ closeReadyReceipt: receipt(40n) })

      await closeSocketSession({
        activeSocket,
        createSessionCredential: async () => 'close-credential',
        currentSocket,
        spent: 20n,
        target: target(),
        waitForCloseReady: async () => {
          throw new Error('unexpected close-ready wait')
        },
        waitForReceipt: async () => finalReceipt,
      })

      expect(activeSocket.send).toHaveBeenCalledOnce()
      expect(activeSocket.send).toHaveBeenCalledWith(
        Ws.formatAuthorizationMessage('close-credential'),
      )
    })

    test('rejects close-ready spend beyond local voucher state', async () => {
      await expect(
        closeSocketSession({
          activeSocket: socket(),
          createSessionCredential: async () => 'close-credential',
          currentSocket: socketSession({ closeReadyReceipt: receipt(101n) }),
          spent: 50n,
          target: target(),
          waitForCloseReady: async () => receipt(101n),
          waitForReceipt: async () => receipt(101n, true),
        }),
      ).rejects.toThrow('close-ready spent exceeds local voucher state')
    })
  })
})
