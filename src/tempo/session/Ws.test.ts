import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Store from '../../Store.js'
import * as ChannelStore from './ChannelStore.js'
import { createSessionReceipt, serializeSessionReceipt } from './Receipt.js'
import * as Ws from './Ws.js'

const challenge = Challenge.from({
  id: 'challenge-1',
  realm: 'example.test',
  method: 'tempo',
  intent: 'session',
  request: {
    amount: '1',
    currency: '0x20c0000000000000000000000000000000000001',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    decimals: 6,
  },
})

const channelId = `0x${'11'.repeat(32)}` as const

class MockSocket implements Ws.Socket {
  closed = false
  sent: string[] = []
  private listeners = {
    close: new Set<() => void>(),
    error: new Set<() => void>(),
    message: new Set<(data: unknown) => void>(),
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const listener of Array.from(this.listeners.close)) listener()
  }

  off(type: 'close' | 'error' | 'message', listener: (...args: any[]) => void) {
    ;(this.listeners[type] as Set<(...args: any[]) => void>).delete(listener)
  }

  on(type: 'close' | 'error' | 'message', listener: (...args: any[]) => void) {
    ;(this.listeners[type] as Set<(...args: any[]) => void>).add(listener)
  }

  receive(data: string) {
    for (const listener of Array.from(this.listeners.message)) listener(data)
  }

  send(data: string) {
    this.sent.push(data)
  }
}

function makeCredential(
  payload:
    | {
        action: 'open'
        type: 'transaction'
        channelId: `0x${string}`
        transaction: `0x${string}`
        cumulativeAmount: string
        signature: `0x${string}`
      }
    | {
        action: 'topUp'
        type: 'transaction'
        channelId: `0x${string}`
        transaction: `0x${string}`
        additionalDeposit: string
      },
) {
  return Credential.serialize(
    Credential.from({
      challenge,
      payload,
    }),
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function memoryChannelStore(): ChannelStore.ChannelStore {
  const channels = new Map()
  return {
    async getChannel(id) {
      return channels.get(id) ?? null
    },
    async updateChannel(id, fn) {
      const result = fn(channels.get(id) ?? null)
      if (result) channels.set(id, result)
      else channels.delete(id)
      return result
    },
  }
}

function seedChannel(
  store: ChannelStore.ChannelStore,
  balance: bigint,
): Promise<ChannelStore.State | null> {
  return store.updateChannel(channelId, () => ({
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    chainId: 42431,
    escrowContract: '0x0000000000000000000000000000000000000005' as Address,
    deposit: balance,
    settledOnChain: 0n,
    highestVoucherAmount: balance,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    closeRequestedAt: 0n,
    finalized: false,
    createdAt: new Date().toISOString(),
  }))
}

describe('parseMessage', () => {
  test('rejects non-object data in payment-receipt', () => {
    expect(Ws.parseMessage('{"mpp":"payment-receipt","data":true}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-receipt","data":42}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-receipt","data":"hello"}')).toBeNull()
  })

  test('rejects non-object data in payment-need-voucher', () => {
    expect(Ws.parseMessage('{"mpp":"payment-need-voucher","data":true}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-need-voucher","data":42}')).toBeNull()
  })

  test('rejects non-object data in payment-close-ready', () => {
    expect(Ws.parseMessage('{"mpp":"payment-close-ready","data":"nope"}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-close-ready","data":[]}')).toBeNull()
  })

  test('rejects objects missing required fields', () => {
    expect(Ws.parseMessage('{"mpp":"payment-receipt","data":{"foo":"bar"}}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-need-voucher","data":{"channelId":"0x01"}}')).toBeNull()
    expect(Ws.parseMessage('{"mpp":"payment-receipt","data":{"challengeId":"x"}}')).toBeNull()
  })

  test('accepts well-formed payment-receipt', () => {
    const receipt = {
      mpp: 'payment-receipt',
      data: {
        method: 'tempo',
        intent: 'session',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: '0x01',
        challengeId: 'c1',
        channelId: '0x02',
        acceptedCumulative: '100',
        spent: '50',
        units: 1,
      },
    }
    const parsed = Ws.parseMessage(JSON.stringify(receipt))
    expect(parsed?.mpp).toBe('payment-receipt')
  })

  test('accepts well-formed payment-need-voucher', () => {
    const event = {
      mpp: 'payment-need-voucher',
      data: {
        channelId: '0x01',
        requiredCumulative: '200',
        acceptedCumulative: '100',
        deposit: '1000',
      },
    }
    const parsed = Ws.parseMessage(JSON.stringify(event))
    expect(parsed?.mpp).toBe('payment-need-voucher')
  })
})

describe('isows', () => {
  test('wraps application payloads in an explicit message envelope', async () => {
    const socket = new MockSocket()

    await Ws.serve({
      socket,
      store: Store.memory(),
      url: 'ws://example.test/stream',
      route: async () => ({
        status: 200,
        withReceipt(response = new Response(null, { status: 204 })) {
          response.headers.set(
            'Payment-Receipt',
            serializeSessionReceipt(
              createSessionReceipt({
                challengeId: challenge.id,
                channelId,
                acceptedCumulative: 1n,
                spent: 0n,
                units: 0,
              }),
            ),
          )
          return response
        },
      }),
      generate: async function* () {
        yield '{"mpp":"payment-need-voucher","data":{"requiredCumulative":"9"}}'
      },
    })

    socket.receive(
      Ws.formatAuthorizationMessage(
        makeCredential({
          action: 'open',
          channelId,
          cumulativeAmount: '1',
          signature: `0x${'77'.repeat(65)}`,
          transaction: '0x01',
          type: 'transaction',
        }),
      ),
    )

    await sleep(10)

    const applicationFrame = socket.sent
      .map((message) => Ws.parseMessage(message))
      .find((message) => message?.mpp === 'message')

    expect(applicationFrame).toEqual({
      mpp: 'message',
      data: '{"mpp":"payment-need-voucher","data":{"requiredCumulative":"9"}}',
    })
  })

  test('caps queued payment work and closes noisy sockets', async () => {
    const socket = new MockSocket()
    let routeCalls = 0

    await Ws.serve({
      socket,
      store: Store.memory(),
      url: 'ws://example.test/stream',
      route: async () => {
        routeCalls++
        await sleep(20)
        return {
          status: 200,
          withReceipt(response = new Response(null, { status: 204 })) {
            response.headers.set(
              'Payment-Receipt',
              serializeSessionReceipt(
                createSessionReceipt({
                  challengeId: challenge.id,
                  channelId,
                  acceptedCumulative: 1n,
                  spent: 0n,
                  units: 0,
                }),
              ),
            )
            return response
          },
        }
      },
      generate: async function* () {},
    })

    const topUp = Ws.formatAuthorizationMessage(
      makeCredential({
        action: 'topUp',
        channelId,
        additionalDeposit: '1',
        transaction: '0x01',
        type: 'transaction',
      }),
    )

    for (let i = 0; i < 40; i++) socket.receive(topUp)

    await sleep(100)

    expect(socket.closed).toBe(true)
    expect(routeCalls).toBeLessThan(40)
    expect(
      socket.sent.some((message) => message.includes('too many queued payment messages')),
    ).toBe(true)
  })

  test('rejects credentials whose amount does not match the expected amount', async () => {
    const socket = new MockSocket()

    await Ws.serve({
      socket,
      store: Store.memory(),
      url: 'ws://example.test/stream',
      amount: '999',
      route: async () => ({
        status: 200,
        withReceipt(response = new Response(null, { status: 204 })) {
          response.headers.set(
            'Payment-Receipt',
            serializeSessionReceipt(
              createSessionReceipt({
                challengeId: challenge.id,
                channelId,
                acceptedCumulative: 1n,
                spent: 0n,
                units: 0,
              }),
            ),
          )
          return response
        },
      }),
      generate: async function* () {
        yield 'should-not-reach'
      },
    })

    socket.receive(
      Ws.formatAuthorizationMessage(
        makeCredential({
          action: 'open',
          channelId,
          cumulativeAmount: '1',
          signature: `0x${'77'.repeat(65)}`,
          transaction: '0x01',
          type: 'transaction',
        }),
      ),
    )

    await sleep(10)

    expect(socket.closed).toBe(true)
    expect(
      socket.sent.some((m) => m.includes('credential amount does not match this endpoint')),
    ).toBe(true)
    expect(socket.sent.some((m) => m.includes('should-not-reach'))).toBe(false)
  })

  test('drops reserved charges when the stream ends without delivering a chunk', async () => {
    const socket = new MockSocket()
    const store = memoryChannelStore()
    await seedChannel(store, 1n)

    await Ws.serve({
      socket,
      store,
      url: 'ws://example.test/stream',
      route: async () => ({
        status: 200,
        withReceipt(response = new Response(null, { status: 204 })) {
          response.headers.set(
            'Payment-Receipt',
            serializeSessionReceipt(
              createSessionReceipt({
                challengeId: challenge.id,
                channelId,
                acceptedCumulative: 1n,
                spent: 0n,
                units: 0,
              }),
            ),
          )
          return response
        },
      }),
      generate: async function* (stream) {
        await stream.charge()
        yield* []
      },
    })

    socket.receive(
      Ws.formatAuthorizationMessage(
        makeCredential({
          action: 'open',
          channelId,
          cumulativeAmount: '1',
          signature: `0x${'77'.repeat(65)}`,
          transaction: '0x01',
          type: 'transaction',
        }),
      ),
    )

    await sleep(10)

    const closeReady = socket.sent
      .map((message) => Ws.parseMessage(message))
      .find((message) => message?.mpp === 'payment-close-ready')

    expect(closeReady?.mpp).toBe('payment-close-ready')
    if (closeReady?.mpp === 'payment-close-ready') {
      expect(closeReady.data.spent).toBe('0')
      expect(closeReady.data.units).toBe(0)
    }

    const channel = await store.getChannel(channelId)
    expect(channel?.spent).toBe(0n)
    expect(channel?.units).toBe(0)
  })
})
