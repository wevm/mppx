import { createClient, custom, encodeFunctionResult, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import * as Channel from '../precompile/Channel.js'
import { escrowAbi } from '../precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import { createSessionReceipt, serializeSessionReceipt } from '../precompile/Protocol.js'
import type { NeedVoucherEvent, SessionReceipt } from '../precompile/Protocol.js'
import { formatNeedVoucherEvent, parseEvent } from '../precompile/Protocol.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'
import { computeFallbackCloseAmount, sessionManager } from './SessionManager.js'
import type { StoredSessionChannel } from './SessionManager.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'test-challenge-1'
const realm = 'test.example.com'
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const client = createClient({
  account,
  chain: { id: 4217 } as never,
  transport: custom({
    async request(args) {
      if (args.method === 'eth_chainId') return '0x1079'
      if (args.method === 'eth_getTransactionCount') return '0x0'
      if (args.method === 'eth_estimateGas') return '0x5208'
      if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
      if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
      if (args.method === 'eth_call')
        return encodeFunctionResult({
          abi: escrowAbi,
          functionName: 'getChannelState',
          result: { settled: 0n, deposit: 10_000_000n, closeRequestedAt: 0 },
        })
      throw new Error(`unexpected rpc request: ${args.method}`)
    },
  }),
})

const storedDescriptor = {
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'11'.repeat(32)}` as Hex,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  payee: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00' as Address,
  payer: account.address,
  salt: `0x${'22'.repeat(32)}` as Hex,
  token: '0x20c0000000000000000000000000000000000001' as Address,
}

const storedChannelId = Channel.computeId({
  ...storedDescriptor,
  chainId: 4217,
  escrow: tip20ChannelEscrow,
})

function storedChannel(overrides: Partial<StoredSessionChannel> = {}): StoredSessionChannel {
  return {
    channelId: storedChannelId,
    cumulativeAmount: '1000000',
    deposit: '10000000',
    descriptor: storedDescriptor,
    escrow: tip20ChannelEscrow,
    chainId: 4217,
    opened: true,
    updatedAt: 0,
    ...overrides,
  }
}

function makeChallenge(overrides: Record<string, unknown> = {}): Challenge.Challenge {
  return Challenge.from({
    id: challengeId,
    realm,
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
      decimals: 6,
      methodDetails: {
        escrowContract: tip20ChannelEscrow,
        chainId: 4217,
        sessionProtocol: Constants.SessionProtocols.tip1034,
      },
      ...overrides,
    },
  })
}

function makeChargeChallenge(): Challenge.Challenge {
  return Challenge.from({
    id: 'charge-bootstrap',
    realm,
    method: 'tempo',
    intent: 'charge',
    request: {
      amount: '0',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35cc6634c0532925a3b844bc9e7595f8fe00',
      methodDetails: { chainId: 4217 },
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
  describe('computeFallbackCloseAmount', () => {
    test('uses matching close-ready receipt spend first', () => {
      const receipt = createSessionReceipt({
        acceptedCumulative: 100n,
        challengeId,
        channelId,
        spent: 80n,
      })

      expect(
        computeFallbackCloseAmount({
          challengeId,
          channelId,
          closeReadyReceipt: receipt,
          cumulativeAmount: 100n,
          deliveredChunks: 10n,
          socketChallengeId: challengeId,
          socketChannelId: channelId,
          spent: 50n,
          tickCost: 10n,
        }),
      ).toBe(80n)
    })

    test('uses matching socket delivery estimate clamped to cumulative authorization', () => {
      expect(
        computeFallbackCloseAmount({
          challengeId,
          channelId,
          cumulativeAmount: 90n,
          deliveredChunks: 10n,
          socketChallengeId: challengeId,
          socketChannelId: channelId,
          spent: 40n,
          tickCost: 10n,
        }),
      ).toBe(90n)
    })

    test('uses receipt-tracked spend when no socket estimate applies', () => {
      expect(
        computeFallbackCloseAmount({
          challengeId,
          channelId,
          cumulativeAmount: 100n,
          deliveredChunks: 10n,
          socketChallengeId: 'other-challenge',
          socketChannelId: channelId,
          spent: 40n,
          tickCost: 10n,
        }),
      ).toBe(40n)
    })
  })

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

    test('binds the default global fetch for browser runtimes', async () => {
      const originalFetch = globalThis.fetch
      const mockFetch = vi.fn(function (this: unknown) {
        expect(this).toBe(globalThis)
        return Promise.resolve(makeOkResponse('hello'))
      })
      globalThis.fetch = mockFetch as typeof globalThis.fetch
      try {
        const s = sessionManager({
          account: '0x0000000000000000000000000000000000000001',
        })

        const res = await s.fetch('https://api.example.com/data')

        expect(res.status).toBe(200)
        expect(mockFetch).toHaveBeenCalledOnce()
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test('adds a stored channel hint to the first request', async () => {
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Payment-Session')).toBe(storedChannelId)
        return Promise.resolve(makeOkResponse())
      })
      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        sessionStore: {
          get: () => storedChannel(),
          set: vi.fn(),
        },
      })

      await s.fetch('https://api.example.com/data')

      expect(mockFetch).toHaveBeenCalledOnce()
    })

    test('bootstraps from same-route HEAD snapshot before first request', async () => {
      const set = vi.fn()
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (init?.method === 'HEAD' && !headers.get(Constants.Headers.authorization)) {
          expect(headers.get(Constants.Headers.acceptPayment)).toBe('tempo/charge')
          return Promise.resolve(make402Response(makeChargeChallenge()))
        }
        if (init?.method === 'HEAD') {
          const credential = Credential.deserialize(headers.get(Constants.Headers.authorization)!)
          expect(credential.payload).toMatchObject({ type: 'proof' })
          return Promise.resolve(
            new Response(null, {
              status: 204,
              headers: {
                [Constants.Headers.paymentSessionSnapshot]: sessionManager.serializeSnapshot({
                  acceptedCumulative: '1000000',
                  channelId: storedChannelId,
                  deposit: '10000000',
                  descriptor: storedDescriptor,
                  requiredCumulative: '1000000',
                  settled: '0',
                  spent: '0',
                  units: 0,
                }),
              },
            }),
          )
        }
        expect(headers.get(Constants.Headers.paymentSession)).toBe(storedChannelId)
        return Promise.resolve(makeOkResponse())
      })
      const s = sessionManager({
        account,
        bootstrap: true,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        sessionStore: {
          get: () => null,
          set,
        },
      })

      const response = await s.fetch('https://api.example.com/data')

      expect(response.status).toBe(200)
      expect(s.channelId).toBe(storedChannelId)
      expect(s.cumulative).toBe(1_000_000n)
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ channelId: storedChannelId }))
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    test('falls back to normal fetch when bootstrap is unsupported', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(makeOkResponse())
      const s = sessionManager({
        account,
        bootstrap: true,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
      })

      const response = await s.fetch('https://api.example.com/data')

      expect(response.status).toBe(200)
      expect(s.channelId).toBeUndefined()
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
      expect(new Headers(mockFetch.mock.calls[1]?.[1]?.headers).get('Payment-Session')).toBeNull()
    })

    test('clears stale stored channel hints and retries with a fresh channel', async () => {
      const remove = vi.fn()
      const staleClient = createClient({
        account,
        chain: { id: 4217 } as never,
        transport: custom({
          async request(args) {
            if (args.method === 'eth_chainId') return '0x1079'
            if (args.method === 'eth_getTransactionCount') return '0x0'
            if (args.method === 'eth_estimateGas') return '0x5208'
            if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
            if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
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
      const postedPayloads: SessionCredentialPayload[] = []
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const authorization = headers.get(Constants.Headers.authorization)
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 204 }))
        if (!payload) return Promise.resolve(make402Response())
        return Promise.resolve(makeOkResponse())
      })
      const s = sessionManager({
        account,
        bootstrap: true,
        client: staleClient,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
        sessionStore: {
          get: () => storedChannel(),
          set: vi.fn(),
          delete: remove,
        },
      })

      const response = await s.fetch('https://api.example.com/data')

      expect(response.status).toBe(200)
      expect(remove).toHaveBeenCalledOnce()
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open'])
      expect(s.opened).toBe(true)
      expect(s.channelId).not.toBe(storedChannelId)
    })

    test('does not bootstrap when disabled', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse())
      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
      })

      await s.fetch('https://api.example.com/data')

      expect(mockFetch).toHaveBeenCalledOnce()
      expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get('Payment-Session')).toBeNull()
    })

    test('uses stored channel details when the server does not return a snapshot', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (!payload) return Promise.resolve(make402Response())
        return Promise.resolve(makeOkResponse())
      })
      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        sessionStore: {
          get: () => storedChannel(),
          set: vi.fn(),
        },
      })

      await s.fetch('https://api.example.com/data')

      expect(postedPayloads[0]).toMatchObject({
        action: 'voucher',
        channelId: storedChannelId,
      })
    })

    test('persists opened channels and deletes closed channels when supported', async () => {
      const set = vi.fn()
      const remove = vi.fn()
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        callCount++

        if (callCount === 1) return Promise.resolve(make402Response())
        if (payload?.action === 'open') {
          return Promise.resolve(
            new Response('ok', {
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: BigInt(payload.cumulativeAmount),
                    challengeId,
                    channelId: payload.channelId,
                    spent: 0n,
                  }),
                ),
              },
            }),
          )
        }
        if (payload?.action === 'close') {
          return Promise.resolve(
            new Response('ok', {
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: BigInt(payload.cumulativeAmount),
                    challengeId,
                    channelId: payload.channelId,
                    spent: BigInt(payload.cumulativeAmount),
                    txHash: `0x${'aa'.repeat(32)}`,
                  }),
                ),
              },
            }),
          )
        }
        return Promise.resolve(makeOkResponse())
      })
      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
        sessionStore: {
          get: () => null,
          set,
          delete: remove,
        },
      })

      await s.fetch('https://api.example.com/data')
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: s.channelId,
          opened: true,
        }),
      )

      await s.close()
      expect(remove).toHaveBeenCalledOnce()
    })

    test('rolls back state when opening a channel throws', async () => {
      const failingClient = createClient({
        account,
        chain: { id: 4217 } as never,
        transport: custom({
          async request(args) {
            if (args.method === 'eth_chainId') return '0x1079'
            if (args.method === 'eth_getTransactionCount') return '0x0'
            if (args.method === 'eth_estimateGas') throw new Error('insufficient balance')
            if (args.method === 'eth_maxPriorityFeePerGas') return '0x1'
            if (args.method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
            throw new Error(`unexpected rpc request: ${args.method}`)
          },
        }),
      })
      const mockFetch = vi.fn().mockResolvedValue(make402Response())
      const s = sessionManager({
        account,
        client: failingClient,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      await expect(s.fetch('https://api.example.com/data')).rejects.toThrow(/insufficient balance/)

      expect(s.state).toEqual({ status: 'idle' })
      expect(s.opened).toBe(false)
      expect(s.cumulative).toBe(0n)
    })

    test('automatically top-ups and retries when an HTTP session exceeds deposit', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        callCount++
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (callCount === 1)
          return Promise.resolve(make402Response(makeChallenge({ suggestedDeposit: '1000000' })))

        if (payload?.action === 'open') {
          return Promise.resolve(
            make402Response(
              makeChallenge({
                methodDetails: {
                  escrowContract: tip20ChannelEscrow,
                  chainId: 4217,
                  sessionSnapshot: {
                    acceptedCumulative: '2000000',
                    channelId: payload.channelId,
                    deposit: '1000000',
                    descriptor: payload.descriptor,
                    requiredCumulative: '2000000',
                    settled: '0',
                    spent: '1000000',
                    units: 1,
                  },
                },
              }),
            ),
          )
        }

        if (payload?.action === 'topUp') return Promise.resolve(makeOkResponse())

        if (payload?.action === 'voucher') {
          return Promise.resolve(
            new Response('paid', {
              status: 200,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: 2_000_000n,
                    challengeId,
                    channelId: payload.channelId,
                    spent: 2_000_000n,
                    units: 2,
                  }),
                ),
              },
            }),
          )
        }

        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      const response = await s.fetch('https://api.example.com/data')

      expect(response.status).toBe(200)
      expect(await response.text()).toBe('paid')
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open', 'topUp', 'voucher'])
      expect(s.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '2000000',
        deposit: '2000000',
        spent: '2000000',
        units: 2,
      })
    })

    test('preemptively top-ups before signing an HTTP voucher that exceeds deposit', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      let challengeCount = 0
      const receipt = (payload: Extract<SessionCredentialPayload, { channelId: Hex }>) =>
        new Response('paid', {
          status: 200,
          headers: {
            'Payment-Receipt': serializeSessionReceipt(
              createSessionReceipt({
                acceptedCumulative: BigInt(
                  'cumulativeAmount' in payload ? payload.cumulativeAmount : '1000000',
                ),
                challengeId,
                channelId: payload.channelId,
                spent: BigInt('cumulativeAmount' in payload ? payload.cumulativeAmount : '1000000'),
                units:
                  'cumulativeAmount' in payload && payload.cumulativeAmount === '2000000' ? 2 : 1,
              }),
            ),
          },
        })
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (!payload) {
          challengeCount++
          return Promise.resolve(
            make402Response(
              makeChallenge(challengeCount === 1 ? { suggestedDeposit: '1000000' } : {}),
            ),
          )
        }
        if (payload.action === 'topUp') return Promise.resolve(makeOkResponse())
        if (payload.action === 'open' || payload.action === 'voucher')
          return Promise.resolve(receipt(payload))
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      await s.fetch('https://api.example.com/data')
      const response = await s.fetch('https://api.example.com/data')

      expect(response.status).toBe(200)
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open', 'topUp', 'voucher'])
      expect(s.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '2000000',
        deposit: '2000000',
        spent: '2000000',
        units: 2,
      })
    })
  })

  describe('.topUp()', () => {
    test('posts a precompile top-up credential for the active channel', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        callCount++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization) {
          postedPayloads.push(
            Credential.deserialize<SessionCredentialPayload>(authorization).payload,
          )
        }
        if (callCount === 1)
          return Promise.resolve(make402Response(makeChallenge({ suggestedDeposit: '5000000' })))
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      await s.fetch('https://api.example.com/data')
      expect(s.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '1000000',
        deposit: '5000000',
      })
      const receipt = await s.topUp('1')

      expect(receipt).toBeUndefined()
      expect(s.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '1000000',
        deposit: '6000000',
      })
      expect(postedPayloads[0]?.action).toBe('open')
      expect(postedPayloads[1]?.action).toBe('topUp')
      const openPayload = postedPayloads[0]
      const topUpPayload = postedPayloads[1]
      if (openPayload?.action !== 'open' || topUpPayload?.action !== 'topUp') {
        throw new Error('expected open then top-up payloads')
      }
      expect(topUpPayload.channelId).toBe(openPayload.channelId)
      expect(topUpPayload.descriptor).toEqual(openPayload.descriptor)
      expect(topUpPayload.additionalDeposit).toBe('1000000')
    })

    test('rejects top-up before a channel is open', async () => {
      const s = sessionManager({
        account,
        client,
        fetch: vi.fn() as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      await expect(s.topUp('1')).rejects.toThrow('Cannot top up session: no open channel.')
    })

    test('rolls back optimistic vouchers when the paid retry fails', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        callCount++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization) {
          postedPayloads.push(
            Credential.deserialize<SessionCredentialPayload>(authorization).payload,
          )
        }
        if (callCount === 1)
          return Promise.resolve(make402Response(makeChallenge({ suggestedDeposit: '3000000' })))
        if (callCount === 3) return Promise.resolve(make402Response())
        if (callCount === 4) return Promise.resolve(make402Response())
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '3',
      })

      await s.fetch('https://api.example.com/data')
      expect(s.cumulative).toBe(1000000n)

      const failed = await s.fetch('https://api.example.com/data')
      expect(failed.status).toBe(402)
      expect(s.cumulative).toBe(1000000n)

      await s.topUp('1')
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open', 'voucher', 'topUp'])
      const topUpPayload = postedPayloads[2]
      if (topUpPayload?.action !== 'topUp') throw new Error('expected top-up payload')
      expect(topUpPayload.additionalDeposit).toBe('1000000')
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

    test('posts precompile SSE top-up vouchers with the channel descriptor', async () => {
      const requestedUrls: string[] = []
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((input, init?: RequestInit) => {
        callCount++
        requestedUrls.push(input.toString())
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization) {
          postedPayloads.push(
            Credential.deserialize<SessionCredentialPayload>(authorization).payload,
          )
        }
        if (callCount === 1) return Promise.resolve(make402Response())
        if (callCount === 2) {
          const openPayload = postedPayloads[0]
          if (openPayload?.action !== 'open') throw new Error('expected open payload')
          const needVoucher: NeedVoucherEvent = {
            channelId: openPayload.channelId,
            requiredCumulative: '2000000',
            acceptedCumulative: '1000000',
            deposit: '10000000',
          }
          return Promise.resolve(
            makeSseResponse([
              'event: message\ndata: chunk1\n\n',
              formatNeedVoucherEvent(needVoucher),
              'event: message\ndata: chunk2\n\n',
            ]),
          )
        }
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      const iterable = await s.sse('https://api.example.com/stream?prompt=paid')
      const messages: string[] = []
      for await (const msg of iterable) messages.push(msg)

      expect(messages).toEqual(['chunk1', 'chunk2'])
      expect(postedPayloads[0]?.action).toBe('open')
      expect(postedPayloads[1]?.action).toBe('voucher')
      const openPayload = postedPayloads[0]
      const voucherPayload = postedPayloads[1]
      if (openPayload?.action !== 'open' || voucherPayload?.action !== 'voucher')
        throw new Error('expected open then voucher payloads')
      expect(voucherPayload.channelId).toBe(openPayload.channelId)
      expect(voucherPayload.descriptor).toEqual(openPayload.descriptor)
      expect(voucherPayload.cumulativeAmount).toBe('2000000')
      expect(requestedUrls[2]).toBe('https://api.example.com/stream')
    })

    test('ignores precompile SSE voucher requests for a different channel', async () => {
      const mismatchedChannelId = `0x${'ff'.repeat(32)}` as Hex
      const needVoucher: NeedVoucherEvent = {
        channelId: mismatchedChannelId,
        requiredCumulative: '2000000',
        acceptedCumulative: '1000000',
        deposit: '10000000',
      }
      const events = [
        'event: message\ndata: chunk1\n\n',
        formatNeedVoucherEvent(needVoucher),
        'event: message\ndata: chunk2\n\n',
      ]
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        callCount++
        const authorization = new Headers(init?.headers).get('Authorization')
        if (authorization) {
          postedPayloads.push(
            Credential.deserialize<SessionCredentialPayload>(authorization).payload,
          )
        }
        if (callCount === 1) return Promise.resolve(make402Response())
        if (callCount === 2) return Promise.resolve(makeSseResponse(events))
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      const iterable = await s.sse('https://api.example.com/stream')
      const messages: string[] = []
      for await (const msg of iterable) messages.push(msg)

      expect(messages).toEqual(['chunk1', 'chunk2'])
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open'])
      expect(callCount).toBe(2)
    })

    test('retries for the event stream after an open management response', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        callCount++
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (!payload) {
          return Promise.resolve(make402Response(makeChallenge({ suggestedDeposit: '5000000' })))
        }

        if (payload.action === 'open') {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: 1_000_000n,
                    challengeId,
                    channelId: payload.channelId,
                    spent: 1_000_000n,
                    units: 1,
                  }),
                ),
              },
            }),
          )
        }

        if (payload.action === 'voucher') {
          return Promise.resolve(
            makeSseResponse([
              'event: message\ndata: chunk1\n\n',
              'event: message\ndata: chunk2\n\n',
              `event: payment-receipt\ndata: ${JSON.stringify(
                createSessionReceipt({
                  acceptedCumulative: BigInt(payload.cumulativeAmount),
                  challengeId,
                  channelId: payload.channelId,
                  spent: BigInt(payload.cumulativeAmount),
                  units: 2,
                }),
              )}\n\n`,
            ]),
          )
        }

        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '10',
      })

      const iterable = await s.sse('https://api.example.com/stream')
      const messages: string[] = []
      for await (const msg of iterable) messages.push(msg)

      expect(messages).toEqual(['chunk1', 'chunk2'])
      expect(postedPayloads.map((payload) => payload.action)).toEqual(['open', 'voucher'])
      expect(callCount).toBe(4)
      expect(s.state).toMatchObject({
        status: 'active',
        acceptedCumulative: '2000000',
        deposit: '5000000',
        spent: '2000000',
        units: 2,
      })
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

    test('tracks spent from HTTP error receipts and closes at that amount', async () => {
      const postedPayloads: SessionCredentialPayload[] = []
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined
        if (payload) postedPayloads.push(payload)

        if (!payload)
          return Promise.resolve(
            make402Response(makeChallenge({ amount: '1', suggestedDeposit: '2' })),
          )
        if (payload.action === 'open') {
          return Promise.resolve(
            new Response('upstream failed', {
              status: 500,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: BigInt(payload.cumulativeAmount),
                    challengeId,
                    channelId: payload.channelId,
                    spent: 1n,
                    units: 1,
                  }),
                ),
              },
            }),
          )
        }
        if (payload.action === 'close') {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: BigInt(payload.cumulativeAmount),
                    challengeId,
                    channelId: payload.channelId,
                    spent: BigInt(payload.cumulativeAmount),
                    units: 1,
                  }),
                ),
              },
            }),
          )
        }
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        decimals: 0,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '2',
      })

      const response = await s.fetch('https://api.example.com/resource')
      expect(response.status).toBe(500)
      expect(response.receipt?.spent).toBe('1')

      const closeReceipt = await s.close()
      expect(closeReceipt?.status).toBe('success')
      expect(closeReceipt?.spent).toBe('1')
      expect(s.state).toMatchObject({
        status: 'closed',
        channelId: closeReceipt?.channelId,
      })
      const closePayload = postedPayloads.find((payload) => payload.action === 'close')
      expect(closePayload?.cumulativeAmount).toBe('1')
    })

    test('rejects receipts that exceed the locally signed voucher', async () => {
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined

        if (!payload)
          return Promise.resolve(
            make402Response(makeChallenge({ amount: '1', suggestedDeposit: '3' })),
          )
        if (payload.action === 'open') {
          return Promise.resolve(
            new Response('ok', {
              status: 200,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: 3n,
                    challengeId,
                    channelId: payload.channelId,
                    spent: 3n,
                    units: 1,
                  }),
                ),
              },
            }),
          )
        }
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        decimals: 0,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '3',
      })

      await expect(s.fetch('https://api.example.com/resource')).rejects.toThrow(
        'receipt accepted cumulative exceeds local voucher state',
      )
    })

    test('surfaces close failure problem details', async () => {
      const mockFetch = vi.fn().mockImplementation((_input, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        const payload = authorization
          ? Credential.deserialize<SessionCredentialPayload>(authorization).payload
          : undefined

        if (!payload)
          return Promise.resolve(
            make402Response(makeChallenge({ amount: '1', suggestedDeposit: '2' })),
          )
        if (payload.action === 'open') {
          return Promise.resolve(
            new Response('ok', {
              status: 200,
              headers: {
                'Payment-Receipt': serializeSessionReceipt(
                  createSessionReceipt({
                    acceptedCumulative: BigInt(payload.cumulativeAmount),
                    challengeId,
                    channelId: payload.channelId,
                    spent: 1n,
                    units: 1,
                  }),
                ),
              },
            }),
          )
        }
        if (payload.action === 'close') {
          return Promise.resolve(
            new Response('close failed', {
              status: 500,
              headers: {
                'WWW-Authenticate': 'Payment error="close_failed"',
              },
            }),
          )
        }
        return Promise.resolve(makeOkResponse())
      })

      const s = sessionManager({
        account,
        client,
        decimals: 0,
        fetch: mockFetch as typeof globalThis.fetch,
        maxDeposit: '2',
      })

      const response = await s.fetch('https://api.example.com/resource')
      expect(response.status).toBe(200)
      expect(response.receipt?.spent).toBe('1')

      await expect(s.close()).rejects.toThrow(
        'Close request failed with status 500: close failed [WWW-Authenticate: Payment error="close_failed"]',
      )
    })
  })
})
