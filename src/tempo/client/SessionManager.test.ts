import type { Hex } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import * as Challenge from '../../Challenge.js'
import { formatNeedVoucherEvent, parseEvent } from '../session/Sse.js'
import type { NeedVoucherEvent, SessionReceipt } from '../session/Types.js'
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
