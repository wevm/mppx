import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account as TempoAccount } from 'viem/tempo'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as PaymentCredential from '../../Credential.js'
import { formatNeedVoucherEvent, parseEvent } from '../session/Sse.js'
import type {
  NeedVoucherEvent,
  SessionCredentialPayload,
  SessionReceipt,
} from '../session/Types.js'
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

function make402Response(...challenges: Challenge.Challenge[]): Response {
  const entries = challenges.length ? challenges : [makeChallenge()]
  return new Response(null, {
    status: 402,
    headers: { 'WWW-Authenticate': entries.map(Challenge.serialize).join(', ') },
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

    test('uses voucherSigner for managed open credentials', async () => {
      vi.resetModules()
      vi.doMock('viem/actions', () => ({
        prepareTransactionRequest: vi.fn(async () => ({})),
        sendCallsSync: vi.fn(),
        signTransaction: vi.fn(async () => '0xdeadbeef'),
        signTypedData: vi.fn(),
      }))

      try {
        const { sessionManager: sessionManagerWithMocks } = await import('./SessionManager.js')
        const account = privateKeyToAccount(
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        )
        const voucherSigner = TempoAccount.fromSecp256k1(
          '0x0000000000000000000000000000000000000000000000000000000000000002',
          { access: account },
        )
        const client = createClient({
          account,
          transport: http('http://127.0.0.1'),
        })
        const challenge = makeChallenge({
          recipient: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
          methodDetails: {
            escrowContract: '0x9d136eea063ede5418a6bc7beaff009bbb6cfa70',
            chainId: 4217,
          },
        })
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce(make402Response(challenge))
          .mockResolvedValueOnce(makeOkResponse())

        const manager = sessionManagerWithMocks({
          account,
          client,
          fetch: mockFetch as typeof globalThis.fetch,
          maxDeposit: '10',
          voucherSigner,
        })

        const response = await manager.fetch('https://api.example.com/data')
        const authorization = new Headers((mockFetch.mock.calls[1]![1] as RequestInit).headers).get(
          'Authorization',
        )

        expect(response.status).toBe(200)
        expect(authorization).toBeDefined()
        if (!authorization) throw new Error('missing authorization header')
        const credential = PaymentCredential.deserialize<SessionCredentialPayload>(authorization)
        expect(credential.payload.action).toBe('open')
        if (credential.payload.action !== 'open') throw new Error('unexpected action')
        expect(credential.payload.authorizedSigner).toBe(voucherSigner.accessKeyAddress)
      } finally {
        vi.doUnmock('viem/actions')
        vi.resetModules()
      }
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

    test('passes supported challenges through the ordering hook', async () => {
      const first = makeChallenge({ currency: 'pathusd' })
      const second = makeChallenge({ currency: 'usdc' })
      const mockFetch = vi.fn().mockResolvedValue(make402Response(first, second))
      const orderChallenges = vi.fn(
        (candidates: Parameters<NonNullable<sessionManager.Parameters['orderChallenges']>>[0]) =>
          candidates.slice(1, 1),
      )

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
        orderChallenges,
      })

      await expect(s.fetch('https://api.example.com/data')).rejects.toThrow(
        'No method found for challenges: tempo.session, tempo.session',
      )
      expect(orderChallenges).toHaveBeenCalledOnce()
      expect(
        orderChallenges.mock.calls[0]?.[0].map(({ challenge, index }) => ({
          currency: challenge.request.currency,
          index,
        })),
      ).toEqual([
        { currency: 'pathusd', index: 0 },
        { currency: 'usdc', index: 1 },
      ])
    })

    test('request-local ordering overrides the session manager ordering hook', async () => {
      const mockFetch = vi.fn().mockResolvedValue(make402Response())
      const configuredOrderChallenges = vi.fn(
        (candidates: Parameters<NonNullable<sessionManager.Parameters['orderChallenges']>>[0]) =>
          candidates,
      )
      const requestOrderChallenges = vi.fn(
        (
          _candidates: Parameters<NonNullable<sessionManager.Parameters['orderChallenges']>>[0],
        ) => [],
      )

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
        orderChallenges: configuredOrderChallenges,
      })

      await expect(
        s.fetch('https://api.example.com/data', {
          orderChallenges: requestOrderChallenges,
        }),
      ).rejects.toThrow('No method found for challenges: tempo.session')
      expect(configuredOrderChallenges).not.toHaveBeenCalled()
      expect(requestOrderChallenges).toHaveBeenCalledOnce()
    })
  })

  describe('.ws()', () => {
    test('applies challenge ordering to the HTTP probe', async () => {
      const mockFetch = vi.fn().mockResolvedValue(make402Response())
      const orderChallenges = vi.fn(
        (
          _candidates: Parameters<NonNullable<sessionManager.Parameters['orderChallenges']>>[0],
        ) => [],
      )

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
        orderChallenges,
        webSocket: vi.fn() as never,
      })

      await expect(s.ws('wss://api.example.com/session')).rejects.toThrow(
        'No payment challenge received from HTTP endpoint for this WebSocket URL.',
      )
      expect(orderChallenges).toHaveBeenCalledOnce()
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
  })

  describe('.sse() event parsing', () => {
    test('sends SSE Accept header on voucher POST updates', async () => {
      vi.resetModules()
      vi.doMock('viem/actions', () => ({
        prepareTransactionRequest: vi.fn(async () => ({})),
        sendCallsSync: vi.fn(),
        signTransaction: vi.fn(async () => '0xdeadbeef'),
        signTypedData: vi.fn(),
      }))

      try {
        const { sessionManager: sessionManagerWithMocks } = await import('./SessionManager.js')
        const account = privateKeyToAccount(
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        )
        const voucherSigner = TempoAccount.fromSecp256k1(
          '0x0000000000000000000000000000000000000000000000000000000000000002',
          { access: account },
        )
        const client = createClient({
          account,
          transport: http('http://127.0.0.1'),
        })
        const challenge = makeChallenge({
          recipient: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
          methodDetails: {
            escrowContract: '0x9d136eea063ede5418a6bc7beaff009bbb6cfa70',
            chainId: 4217,
          },
        })
        const needVoucher: NeedVoucherEvent = {
          channelId,
          requiredCumulative: '2000000',
          acceptedCumulative: '1000000',
          deposit: '10000000',
        }
        const mockFetch = vi
          .fn()
          .mockResolvedValueOnce(make402Response(challenge))
          .mockResolvedValueOnce(
            makeSseResponse([
              formatNeedVoucherEvent(needVoucher),
              'event: message\ndata: chunk\n\n',
            ]),
          )
          .mockResolvedValueOnce(makeOkResponse())

        const s = sessionManagerWithMocks({
          account,
          client,
          fetch: mockFetch as typeof globalThis.fetch,
          maxDeposit: '10',
          voucherSigner,
        })

        const iterable = await s.sse('https://api.example.com/stream')

        const messages: string[] = []
        for await (const msg of iterable) {
          messages.push(msg)
        }

        const voucherRequest = mockFetch.mock.calls[2]![1] as RequestInit
        const voucherHeaders = new Headers(voucherRequest.headers)

        expect(messages).toEqual(['chunk'])
        expect(voucherRequest.method).toBe('POST')
        expect(voucherHeaders.get('accept')).toBe('text/event-stream')
        expect(voucherHeaders.get('authorization')).toBeTruthy()
      } finally {
        vi.doUnmock('viem/actions')
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

      // Manually set channel state to skip auto-open flow
      ;(s as any).__test_setChannel?.()

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

      const calledHeaders = new Headers((mockFetch.mock.calls[0]![1] as RequestInit).headers)
      expect(calledHeaders.get('content-type')).toBe('application/json')
      expect(calledHeaders.get('x-custom')).toBe('value')
      expect(calledHeaders.get('accept')).toBe('text/event-stream')
    })
  })

  describe('.close()', () => {
    test('is no-op when not opened', async () => {
      const mockFetch = vi.fn()

      const s = sessionManager({
        account: '0x0000000000000000000000000000000000000001',
        fetch: mockFetch as typeof globalThis.fetch,
      })

      await s.close()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
