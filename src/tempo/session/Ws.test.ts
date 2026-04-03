import { describe, expect, test } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Store from '../../Store.js'
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

describe('Ws', () => {
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
})
