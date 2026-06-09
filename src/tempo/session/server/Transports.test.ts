import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import { ChannelClosedError } from '../../../Errors.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  commitReservedCharges,
  reserveChargeOrWait,
  send,
  subscribe,
  toText,
  type SocketEventListener,
  type SocketEventMap,
} from './Transports.js'

describe('MeteredStream', () => {
  const channelId = `0x${'01'.repeat(32)}` as Hex

  const descriptor = {
    authorizedSigner: '0x0000000000000000000000000000000000000001' as Address,
    expiringNonceHash: `0x${'11'.repeat(32)}` as Hex,
    operator: '0x0000000000000000000000000000000000000000' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    salt: `0x${'22'.repeat(32)}` as Hex,
    token: '0x20c0000000000000000000000000000000000001' as Address,
  }

  function channel(overrides: Partial<ChannelStore.State> = {}): ChannelStore.State {
    const base: ChannelStore.State = {
      authorizedSigner: descriptor.authorizedSigner,
      backend: 'precompile',
      chainId: 4217,
      escrowContract: '0x4D50500000000000000000000000000000000000' as Address,
      channelId,
      closeRequestedAt: 0n,
      createdAt: '2026-01-01T00:00:00.000Z',
      deposit: 100n,
      descriptor,
      expiringNonceHash: descriptor.expiringNonceHash,
      finalized: false,
      highestVoucher: null,
      highestVoucherAmount: 50n,
      operator: descriptor.operator,
      payee: descriptor.payee,
      payer: descriptor.payer,
      salt: descriptor.salt,
      settledOnChain: 0n,
      spent: 20n,
      token: descriptor.token,
      units: 2,
    }
    return { ...base, ...overrides }
  }

  function memoryStore(
    initial: ChannelStore.State,
    options: { waitForUpdate?: boolean } = {},
  ): ChannelStore.ChannelStore {
    let state: ChannelStore.State | null = initial
    const waiters = new Set<() => void>()
    const store: ChannelStore.ChannelStore = {
      async getChannel() {
        return state
      },
      async updateChannel(_channelId, fn) {
        state = fn(state)
        for (const waiter of waiters) waiter()
        waiters.clear()
        return state
      },
    }
    if (options.waitForUpdate) {
      store.waitForUpdate = () => {
        return new Promise<void>((resolve) => {
          waiters.add(resolve)
        })
      }
    }
    return store
  }

  function formatNeedVoucher(event: NeedVoucherEvent) {
    return JSON.stringify(event)
  }

  describe('MeteredStream', () => {
    test('reserveChargeOrWait returns immediately when voucher headroom is available', async () => {
      const emitted: string[] = []
      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit(message) {
          emitted.push(message)
        },
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservedAmount: 0n,
        store: memoryStore(channel()),
      })

      expect(emitted).toEqual([])
    })

    test('reserveChargeOrWait emits need-voucher and waits for accepted headroom', async () => {
      const emitted: string[] = []
      const store = memoryStore(channel({ highestVoucherAmount: 25n, spent: 20n }))
      const reserved = reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit(message) {
          emitted.push(message)
        },
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservedAmount: 0n,
        store,
      })

      await Promise.resolve()
      expect(emitted.map((item) => JSON.parse(item))).toEqual([
        {
          channelId,
          requiredCumulative: '30',
          acceptedCumulative: '25',
          deposit: '100',
        },
      ])

      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 30n } : current,
      )
      await reserved
    })

    test('reserveChargeOrWait observes updates that happen before wait registration', async () => {
      const emitted: string[] = []
      const store = memoryStore(channel({ highestVoucherAmount: 25n, spent: 20n }), {
        waitForUpdate: true,
      })

      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        async emit(message) {
          emitted.push(message)
          await store.updateChannel(channelId, (current) =>
            current ? { ...current, highestVoucherAmount: 30n } : current,
          )
        },
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservedAmount: 0n,
        store,
      })

      expect(emitted).toHaveLength(1)
    })

    test('commitReservedCharges increments spend and units', async () => {
      const store = memoryStore(channel({ spent: 20n, units: 2, highestVoucherAmount: 50n }))

      await commitReservedCharges({ amount: 10n, channelId, store, units: 1 })

      expect(await store.getChannel(channelId)).toMatchObject({ spent: 30n, units: 3 })
    })

    test('commitReservedCharges rejects when reserved coverage is no longer available', async () => {
      await expect(
        commitReservedCharges({
          amount: 40n,
          channelId,
          store: memoryStore(channel({ spent: 20n, highestVoucherAmount: 50n })),
          units: 1,
        }),
      ).rejects.toThrow('reserved voucher coverage is no longer available')
    })

    test('commitReservedCharges rejects closed channels', async () => {
      await expect(
        commitReservedCharges({
          amount: 10n,
          channelId,
          store: memoryStore(channel({ finalized: true })),
          units: 1,
        }),
      ).rejects.toThrow(ChannelClosedError)
    })
  })
})

describe('SocketTransport', () => {
  class BrowserSocket {
    sent: string[] = []
    listeners = {
      close: new Set<SocketEventListener<'close'>>(),
      error: new Set<SocketEventListener<'error'>>(),
      message: new Set<SocketEventListener<'message'>>(),
    }

    addEventListener<type extends keyof SocketEventMap>(
      type: type,
      listener: SocketEventListener<type>,
    ) {
      this.listeners[type].add(listener as never)
    }

    close() {
      this.emit('close', { type: 'close' })
    }

    emit<type extends keyof SocketEventMap>(type: type, event: SocketEventMap[type]) {
      for (const listener of this.listeners[type]) {
        if (typeof listener === 'function') listener(event as never)
        else listener.handleEvent(event as never)
      }
    }

    removeEventListener<type extends keyof SocketEventMap>(
      type: type,
      listener: SocketEventListener<type>,
    ) {
      this.listeners[type].delete(listener as never)
    }

    send(data: string) {
      this.sent.push(data)
    }
  }

  class NodeSocket {
    sent: string[] = []
    listeners = {
      close: new Set<(event: SocketEventMap['close']) => void>(),
      error: new Set<(event: SocketEventMap['error']) => void>(),
      message: new Set<(event: SocketEventMap['message']) => void>(),
    }

    close() {
      this.emit('close', { type: 'close' })
    }

    emit<type extends keyof SocketEventMap>(type: type, event: SocketEventMap[type]) {
      for (const listener of this.listeners[type]) listener(event as never)
    }

    off<type extends keyof SocketEventMap>(
      type: type,
      listener: (event: SocketEventMap[type]) => void,
    ) {
      this.listeners[type].delete(listener as never)
    }

    on<type extends keyof SocketEventMap>(
      type: type,
      listener: (event: SocketEventMap[type]) => void,
    ) {
      this.listeners[type].add(listener as never)
    }

    send(data: string) {
      this.sent.push(data)
    }
  }

  describe('SocketTransport', () => {
    test('subscribe handles browser-style socket events', () => {
      const socket = new BrowserSocket()
      const messages: unknown[] = []
      let closed = 0
      let errors = 0

      const unsubscribe = subscribe(socket, {
        close() {
          closed++
        },
        error() {
          errors++
        },
        message(value) {
          messages.push(value)
        },
      })

      socket.emit('message', { data: 'hello', type: 'message' })
      socket.emit('error', { type: 'error' })
      socket.emit('close', { type: 'close' })
      unsubscribe()
      socket.emit('message', { data: 'ignored', type: 'message' })

      expect(messages).toEqual(['hello'])
      expect(errors).toBe(1)
      expect(closed).toBe(1)
    })

    test('subscribe handles node-style socket events', () => {
      const socket = new NodeSocket()
      const messages: unknown[] = []

      const unsubscribe = subscribe(socket, {
        close() {},
        error() {},
        message(value) {
          messages.push(value)
        },
      })

      socket.emit('message', { data: 'hello', type: 'message' })
      unsubscribe()
      socket.emit('message', { data: 'ignored', type: 'message' })

      expect(messages).toEqual([{ data: 'hello', type: 'message' }])
    })

    test('subscribe rejects unsupported socket implementations', () => {
      expect(() =>
        subscribe({ close() {}, send() {} }, { close() {}, error() {}, message() {} }),
      ).toThrow('unsupported websocket implementation')
    })

    test('send supports sync and async socket implementations', async () => {
      const syncSocket = new BrowserSocket()
      const asyncSocket = {
        close() {},
        sent: [] as string[],
        async send(data: string) {
          this.sent.push(data)
        },
      }

      await send(syncSocket, 'sync')
      await send(asyncSocket, 'async')

      expect(syncSocket.sent).toEqual(['sync'])
      expect(asyncSocket.sent).toEqual(['async'])
    })

    test('toText normalizes common message payloads', () => {
      expect(toText('hello')).toBe('hello')
      expect(toText(new TextEncoder().encode('bytes'))).toBe('bytes')
      expect(toText(new TextEncoder().encode('buffer').buffer)).toBe('buffer')
      expect(toText({ data: 'object' })).toBeNull()
    })
  })
})
