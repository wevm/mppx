import type { Address, Hex } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import * as Challenge from '../../Challenge.js'
import { serializeSessionReceipt } from '../session/Receipt.js'
import { formatNeedVoucherEvent, parseEvent } from '../session/Sse.js'
import type { NeedVoucherEvent, SessionReceipt } from '../session/Types.js'
import type { ChannelEntry } from './ChannelOps.js'
import { UnrecoverableRestoreError } from './Session.js'
import { sessionManager } from './SessionManager.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'test-challenge-1'
const realm = 'test.example.com'

function makeChallenge(overrides: Record<string, unknown> = {}): Challenge.Challenge {
  return Challenge.from({
    id: challengeId,
    realm,
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      decimals: 6,
      methodDetails: {
        escrowContract: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
        chainId: 4217,
      },
      ...overrides,
    },
  })
}

function make402Response(challenge?: Challenge.Challenge): Response {
  const c = challenge ?? makeChallenge()
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': Challenge.serialize(c) },
  })
}

function makeOkResponse(body?: string): Response {
  return new Response(body ?? 'ok', { status: 200 })
}

function makeSseResponse(events: string[]): Response {
  const body = events.join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function makeProblemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

describe('Session', () => {
  describe('parseEvent round-trip via SSE', () => {
    test('parses message events from SSE stream', () => {
      const raw = 'event: message\ndata: hello world\n\n'
      const event = parseEvent(raw)
      expect(event).toEqual({ type: 'message', data: 'hello world' })
    })

    test('parses payment-need-voucher events', () => {
      const params: NeedVoucherEvent = {
        channelId,
        requiredCumulative: '6000000',
        acceptedCumulative: '5000000',
        deposit: '10000000',
      }
      const raw = formatNeedVoucherEvent(params)
      const event = parseEvent(raw)
      expect(event).toEqual({ type: 'payment-need-voucher', data: params })
    })
  })

  describe('session creation', () => {
    test('creates session with initial state', () => {
      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        maxDeposit: '10',
      })

      expect(s.channelId).toBeUndefined()
      expect(s.cumulative).toBe(0n)
      expect(s.opened).toBe(false)
    })

    test('creates restored session with immediate state', () => {
      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        maxDeposit: '10',
        restore: {
          channelId,
          cumulativeAmount: 5n,
        },
      })

      expect(s.channelId).toBe(channelId)
      expect(s.cumulative).toBe(5n)
      expect(s.opened).toBe(true)
    })

    test('rejects negative restored cumulative amount', () => {
      expect(() =>
        sessionManager({
          account: '0x0000000000000000000000000000000000000001',
          restore: {
            channelId,
            cumulativeAmount: -1n,
          },
        }),
      ).toThrow('restore.cumulativeAmount must be >= 0n')
    })

    test('rejects negative restored spent amount', () => {
      expect(() =>
        sessionManager({
          account: '0x0000000000000000000000000000000000000001',
          restore: {
            channelId,
            cumulativeAmount: 5n,
            spent: -1n,
          },
        }),
      ).toThrow('restore.spent must be >= 0n')
    })

    test('rejects restored spent greater than cumulative amount', () => {
      expect(() =>
        sessionManager({
          account: '0x0000000000000000000000000000000000000001',
          restore: {
            channelId,
            cumulativeAmount: 5n,
            spent: 6n,
          },
        }),
      ).toThrow('restore.spent must be <= restore.cumulativeAmount')
    })
  })

  describe('.fetch()', () => {
    test('passes through non-402 responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse('hello'))

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const res = await s.fetch('https://api.example.com/data')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('hello')
      expect(mockFetch).toHaveBeenCalledOnce()
    })

    test('throws on 402 without maxDeposit or open channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue(make402Response())

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      await expect(s.fetch('https://api.example.com/data')).rejects.toThrow(
        'no `deposit` or `maxDeposit` configured',
      )
    })

    test('reuses restored session on first 402 retry without overriding better live state', async () => {
      vi.resetModules()

      let onChannelUpdate: ((entry: ChannelEntry) => void) | undefined
      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          if (context?.channelId) {
            onChannelUpdate?.({
              channelId,
              salt: '0x01' as Hex,
              cumulativeAmount: 3n,
              escrowContract: '0x0000000000000000000000000000000000000001' as Address,
              chainId: 4217,
              opened: true,
            })
          }

          return 'credential'
        })

      vi.doMock('./Session.js', () => ({
        session: vi.fn((parameters: { onChannelUpdate?: (entry: ChannelEntry) => void }) => {
          onChannelUpdate = parameters.onChannelUpdate
          return {
            name: 'tempo',
            intent: 'session',
            context: {
              parse(value: unknown) {
                return value
              },
            },
            createCredential,
          }
        }),
        UnrecoverableRestoreError,
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            make402Response(
              makeChallenge({
                methodDetails: {
                  escrowContract: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
                  chainId: 4217,
                },
              }),
            ),
          )
          .mockResolvedValueOnce(makeOkResponse('paid'))

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5n,
          },
        })

        const res = await s.fetch('https://api.example.com/data')

        expect(res.status).toBe(200)
        expect(s.cumulative).toBe(3n)
        expect(createCredential).toHaveBeenCalledWith({
          challenge: expect.anything(),
          context: {
            channelId,
            cumulativeAmountRaw: '5',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.resetModules()
      }
    })

    test('deactivates restored reuse hint after failed reuse so later open can proceed', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockRejectedValueOnce(
          new UnrecoverableRestoreError(channelId, 'closed or not found on-chain'),
        )
        .mockResolvedValueOnce('open-credential')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          name: 'tempo',
          intent: 'session',
          context: {
            parse(value: unknown) {
              return value
            },
          },
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            make402Response(
              makeChallenge({
                methodDetails: {
                  escrowContract: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
                  chainId: 4217,
                },
              }),
            ),
          )
          .mockResolvedValueOnce(makeOkResponse('opened'))

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5n,
          },
        })

        await expect(s.fetch('https://api.example.com/data')).rejects.toThrow('cannot be reused')
        await expect(s.open({ deposit: 7n })).resolves.toBeUndefined()

        expect(createCredential).toHaveBeenNthCalledWith(1, {
          challenge: expect.anything(),
          context: {
            channelId,
            cumulativeAmountRaw: '5',
          },
        })
        expect(createCredential).toHaveBeenNthCalledWith(2, {
          challenge: expect.anything(),
          context: {
            depositRaw: '7',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.resetModules()
      }
    })

    test('keeps restore hint after transient reuse error so a later retry can reuse again', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockRejectedValueOnce(new Error('rpc timeout'))
        .mockResolvedValueOnce('retry-credential')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          name: 'tempo',
          intent: 'session',
          context: {
            parse(value: unknown) {
              return value
            },
          },
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(make402Response())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5n,
          },
        })

        await expect(s.fetch('https://api.example.com/data')).rejects.toThrow('rpc timeout')
        await expect(s.fetch('https://api.example.com/data')).resolves.toBeTruthy()

        expect(createCredential).toHaveBeenNthCalledWith(1, {
          challenge: expect.anything(),
          context: {
            channelId,
            cumulativeAmountRaw: '5',
          },
        })
        expect(createCredential).toHaveBeenNthCalledWith(2, {
          challenge: expect.anything(),
          context: {
            channelId,
            cumulativeAmountRaw: '5',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.resetModules()
      }
    })

    test('keeps fresh-session behavior unchanged on first 402 retry without restore', async () => {
      vi.resetModules()

      const createCredential = vi.fn().mockResolvedValue('credential')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          name: 'tempo',
          intent: 'session',
          context: {
            parse(value: unknown) {
              return value
            },
          },
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            make402Response(
              makeChallenge({
                methodDetails: {
                  escrowContract: '0x9d136eEa063eDE5418A6BC7bEafF009bBb6CFa70',
                  chainId: 4217,
                },
              }),
            ),
          )
          .mockResolvedValueOnce(makeOkResponse('paid'))

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
        })

        const res = await s.fetch('https://api.example.com/data')

        expect(res.status).toBe(200)
        expect(createCredential).toHaveBeenCalledWith({
          challenge: expect.anything(),
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.resetModules()
      }
    })
  })

  describe('.open()', () => {
    test('throws when no challenge is available', async () => {
      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        maxDeposit: '10',
      })

      await expect(s.open()).rejects.toThrow('No challenge available')
    })

    test('is no-op for restored sessions already considered open', async () => {
      const mockFetch = vi.fn()

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
        restore: {
          channelId,
          cumulativeAmount: 5n,
        },
      })

      await expect(s.open()).resolves.toBeUndefined()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('uses live cumulative after same-channel update instead of stale restored spent', async () => {
      vi.resetModules()

      const createCredential = vi.fn().mockResolvedValue('credential')
      let onChannelUpdate: ((entry: ChannelEntry) => void) | undefined

      vi.doMock('./Session.js', () => ({
        session: vi.fn((parameters: { onChannelUpdate?: (entry: ChannelEntry) => void }) => {
          onChannelUpdate = parameters.onChannelUpdate
          return { createCredential }
        }),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeOkResponse())
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5n,
          },
        })

        onChannelUpdate?.({
          channelId,
          salt: '0x01' as Hex,
          cumulativeAmount: 3n,
          escrowContract: '0x0000000000000000000000000000000000000001' as Address,
          chainId: 4217,
          opened: true,
        })

        await s.fetch('https://api.example.com/data')
        await s.close()

        expect(createCredential).toHaveBeenCalledWith({
          challenge: expect.anything(),
          context: {
            action: 'close',
            channelId,
            cumulativeAmountRaw: '3',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })
  })

  describe('.sse() event parsing', () => {
    test('preserves headers instances while adding SSE accept header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeSseResponse([]))

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const body = new TextEncoder().encode('{"stream":true}').buffer
      await s.sse('https://api.example.com/stream', {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body,
      })

      const requestInit = mockFetch.mock.calls[0]?.[1]
      const headers = new Headers(requestInit?.headers)

      expect(headers.get('Accept')).toBe('text/event-stream')
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(requestInit?.body).toBe(body)
    })

    test('rejects restored SSE when paid response remains a 402 problem response', async () => {
      vi.resetModules()

      const createCredential = vi.fn().mockResolvedValue('voucher')
      const helperCreateCredential = vi.fn().mockResolvedValue('restore:5000000')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential: helperCreateCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          makeProblemResponse(402, {
            type: 'https://example.com/problems/payment-required',
            title: 'Payment Required',
            detail: 'Session restore voucher was rejected',
          }),
        )

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5_000_000n,
          },
        })

        await expect(s.sse('https://api.example.com/stream')).rejects.toThrow(/status 402/i)
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('restored sse resumes same channel when required cumulative exceeds current', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          return `voucher:${context?.cumulativeAmountRaw}`
        })
      const helperCreateCredential = vi.fn().mockResolvedValue('restore:5000000')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential: helperCreateCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const needVoucher: NeedVoucherEvent = {
          channelId,
          requiredCumulative: '6000000',
          acceptedCumulative: '5000000',
          deposit: '10000000',
        }

        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeSseResponse([formatNeedVoucherEvent(needVoucher)]))
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5_000_000n,
          },
        })

        const iterable = await s.sse('https://api.example.com/stream')
        for await (const _ of iterable) {
        }

        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/stream', {
          method: 'POST',
          headers: { Authorization: 'voucher:6000000' },
        })
        expect(s.channelId).toBe(channelId)
        expect(s.cumulative).toBe(6000000n)
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('restored sse keeps higher current cumulative when it already exceeds required', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          return `voucher:${context?.cumulativeAmountRaw}`
        })
      const helperCreateCredential = vi.fn().mockResolvedValue('restore:7000000')

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential: helperCreateCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const needVoucher: NeedVoucherEvent = {
          channelId,
          requiredCumulative: '6000000',
          acceptedCumulative: '5000000',
          deposit: '10000000',
        }

        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeSseResponse([formatNeedVoucherEvent(needVoucher)]))
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 7_000_000n,
          },
        })

        const iterable = await s.sse('https://api.example.com/stream')
        for await (const _ of iterable) {
        }

        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/stream', {
          method: 'POST',
          headers: { Authorization: 'voucher:7000000' },
        })
        expect(s.channelId).toBe(channelId)
        expect(s.cumulative).toBe(7000000n)
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('yields only message data from SSE stream', async () => {
      const events = [
        'event: message\ndata: chunk1\n\n',
        'event: message\ndata: chunk2\n\n',
        `event: payment-receipt\ndata: ${JSON.stringify({
          method: 'tempo',
          intent: 'session',
          status: 'success',
          timestamp: '2025-01-01T00:00:00.000Z',
          reference: channelId,
          challengeId,
          channelId,
          acceptedCumulative: '2000000',
          spent: '2000000',
          units: 2,
        } satisfies SessionReceipt)}\n\n`,
      ]

      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return Promise.resolve(makeSseResponse(events))
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const receiptCb = vi.fn()
      const iterable = await s.sse('https://api.example.com/stream', {
        onReceipt: receiptCb,
      })

      const messages: string[] = []
      for await (const msg of iterable) {
        messages.push(msg)
      }

      expect(messages).toEqual(['chunk1', 'chunk2'])
      expect(receiptCb).toHaveBeenCalledOnce()
      expect(receiptCb.mock.calls[0]![0].units).toBe(2)
    })

    test('keeps non-restored SSE voucher behavior unchanged', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          return `voucher:${context?.cumulativeAmountRaw}`
        })
      let onChannelUpdate: ((entry: ChannelEntry) => void) | undefined

      vi.doMock('./Session.js', () => ({
        session: vi.fn((parameters: { onChannelUpdate?: (entry: ChannelEntry) => void }) => {
          onChannelUpdate = parameters.onChannelUpdate
          return { createCredential }
        }),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), {})
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const needVoucher: NeedVoucherEvent = {
          channelId,
          requiredCumulative: '2000000',
          acceptedCumulative: '1000000',
          deposit: '10000000',
        }

        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeSseResponse([formatNeedVoucherEvent(needVoucher)]))
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
        })

        onChannelUpdate?.({
          channelId,
          salt: '0x01' as Hex,
          cumulativeAmount: 1_000_000n,
          escrowContract: '0x0000000000000000000000000000000000000001' as Address,
          chainId: 4217,
          opened: true,
        })

        const iterable = await s.sse('https://api.example.com/stream')
        for await (const _ of iterable) {
        }

        expect(createCredential).toHaveBeenLastCalledWith({
          challenge: expect.anything(),
          context: {
            action: 'voucher',
            channelId,
            cumulativeAmountRaw: '2000000',
          },
        })
        expect(s.channelId).toBe(channelId)
        expect(s.cumulative).toBe(2000000n)
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })
  })

  describe('error handling', () => {
    test('.sse() silently skips payment-need-voucher when no channel open', async () => {
      const needVoucher: NeedVoucherEvent = {
        channelId,
        requiredCumulative: '2000000',
        acceptedCumulative: '1000000',
        deposit: '10000000',
      }

      const events = [
        'event: message\ndata: chunk1\n\n',
        formatNeedVoucherEvent(needVoucher),
        'event: message\ndata: chunk2\n\n',
      ]

      const mockFetch = vi.fn().mockResolvedValue(makeSseResponse(events))

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const iterable = await s.sse('https://api.example.com/stream')

      const messages: string[] = []
      for await (const msg of iterable) {
        messages.push(msg)
      }

      expect(messages).toEqual(['chunk1', 'chunk2'])
      expect(mockFetch).toHaveBeenCalledOnce()
    })
  })

  describe('.sse() headers normalization', () => {
    test('preserves Headers instance properties when passed as headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeSseResponse(['event: message\ndata: ok\n\n']))

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const iterable = await s.sse('https://api.example.com/stream', {
        headers: new Headers({ 'Content-Type': 'application/json', 'X-Custom': 'value' }),
      })

      for await (const _ of iterable) {
        // drain
      }

      const calledHeaders = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >
      expect(calledHeaders['content-type']).toBe('application/json')
      expect(calledHeaders['x-custom']).toBe('value')
      expect(calledHeaders.Accept).toBe('text/event-stream')
    })
  })

  describe('.close()', () => {
    test('uses newer receipt spent for restored-only close after a fresh request', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          if (context?.action === 'close') return `close:${context.cumulativeAmountRaw}`
          return 'restore:5000000'
        })

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const receipt: SessionReceipt = {
          method: 'tempo',
          intent: 'session',
          status: 'success',
          timestamp: '2025-01-01T00:00:00.000Z',
          reference: channelId,
          challengeId,
          channelId,
          acceptedCumulative: '5000000',
          spent: '4000000',
          units: 4,
        }

        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            new Response('paid', {
              status: 200,
              headers: { 'Payment-Receipt': serializeSessionReceipt(receipt) },
            }),
          )
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5_000_000n,
            spent: 3_000_000n,
          },
        })

        await s.fetch('https://api.example.com/data')
        await s.close()

        expect(createCredential).toHaveBeenLastCalledWith({
          challenge: expect.anything(),
          context: {
            action: 'close',
            channelId,
            cumulativeAmountRaw: '4000000',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('same-channel live update does not raise restored spent above last accepted amount', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          if (context?.action === 'close') return `close:${context.cumulativeAmountRaw}`
          return 'restore:5000000'
        })
      let onChannelUpdate: ((entry: ChannelEntry) => void) | undefined

      vi.doMock('./Session.js', () => ({
        session: vi.fn((parameters: { onChannelUpdate?: (entry: ChannelEntry) => void }) => {
          onChannelUpdate = parameters.onChannelUpdate
          return { createCredential }
        }),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeOkResponse('paid'))
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5_000_000n,
            spent: 3_000_000n,
          },
        })

        onChannelUpdate?.({
          channelId,
          salt: '0x01' as Hex,
          cumulativeAmount: 5_000_000n,
          escrowContract: '0x0000000000000000000000000000000000000001' as Address,
          chainId: 4217,
          opened: true,
        })

        await s.fetch('https://api.example.com/data')
        await s.close()

        expect(createCredential).toHaveBeenLastCalledWith({
          challenge: expect.anything(),
          context: {
            action: 'close',
            channelId,
            cumulativeAmountRaw: '3000000',
          },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('restored close stays unavailable before any fresh request', async () => {
      const mockFetch = vi.fn()

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
        restore: {
          channelId,
          cumulativeAmount: 5_000_000n,
          spent: 3_000_000n,
        },
      })

      await expect(s.close()).resolves.toBeUndefined()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('restored-only close clears opened state after success', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          if (context?.action === 'close') return `close:${context.cumulativeAmountRaw}`
          return 'restore:5000000'
        })

      vi.doMock('./Session.js', () => ({
        session: vi.fn(() => ({
          createCredential,
        })),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(makeOkResponse('paid'))
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
          restore: {
            channelId,
            cumulativeAmount: 5_000_000n,
            spent: 3_000_000n,
          },
        })

        expect(s.opened).toBe(true)
        await s.fetch('https://api.example.com/data')
        await s.close()
        expect(s.opened).toBe(false)
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })

    test('is no-op when not opened', async () => {
      const mockFetch = vi.fn()

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      await s.close()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('keeps non-restored close behavior unchanged after live request', async () => {
      vi.resetModules()

      const createCredential = vi
        .fn()
        .mockImplementation(async ({ context }: { context?: any }) => {
          return `close:${context?.cumulativeAmountRaw}`
        })
      let onChannelUpdate: ((entry: ChannelEntry) => void) | undefined

      vi.doMock('./Session.js', () => ({
        session: vi.fn((parameters: { onChannelUpdate?: (entry: ChannelEntry) => void }) => {
          onChannelUpdate = parameters.onChannelUpdate
          return { createCredential }
        }),
        UnrecoverableRestoreError,
      }))

      vi.doMock('../../client/internal/Fetch.js', () => ({
        from: ({
          fetch,
          onChallenge,
        }: {
          fetch: typeof globalThis.fetch
          onChallenge: Function
        }) => {
          return async (input: RequestInfo | URL, init?: RequestInit) => {
            await onChallenge(makeChallenge(), { createCredential })
            return fetch(input, init)
          }
        },
      }))

      try {
        const { sessionManager: isolatedSessionManager } = await import('./SessionManager.js')
        const receipt: SessionReceipt = {
          method: 'tempo',
          intent: 'session',
          status: 'success',
          timestamp: '2025-01-01T00:00:00.000Z',
          reference: channelId,
          challengeId,
          channelId,
          acceptedCumulative: '4000000',
          spent: '4000000',
          units: 4,
        }

        const mockFetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            new Response('paid', {
              status: 200,
              headers: { 'Payment-Receipt': serializeSessionReceipt(receipt) },
            }),
          )
          .mockResolvedValueOnce(makeOkResponse())

        const s = isolatedSessionManager({
          account: '0x0000000000000000000000000000000000000001',
          fetch: mockFetch,
        })

        onChannelUpdate?.({
          channelId,
          salt: '0x01' as Hex,
          cumulativeAmount: 4_000_000n,
          escrowContract: '0x0000000000000000000000000000000000000001' as Address,
          chainId: 4217,
          opened: true,
        })

        await s.fetch('https://api.example.com/data')
        await s.close()

        expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/data', {
          method: 'POST',
          headers: { Authorization: 'close:4000000' },
        })
      } finally {
        vi.doUnmock('./Session.js')
        vi.doUnmock('../../client/internal/Fetch.js')
        vi.resetModules()
      }
    })
  })
})
