import type { Address, Hex } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { meterIterable } from './MeteredStream.js'
import {
  commitReservedCharges,
  reserveChargeOrWait,
  releaseReservedCharges,
  renewReservedCharges,
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
        reservationId: 'test',
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
        reservationId: 'test',
        store,
      })

      await vi.waitFor(() => expect(emitted).toHaveLength(1))
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
        reservationId: 'test',
        store,
      })

      expect(emitted).toHaveLength(1)
    })

    test('cancels a store waiter when the polling timeout wins', async () => {
      let reads = 0
      let waiterAborted = false
      const store: ChannelStore.ChannelStore = {
        async getChannel() {
          reads += 1
          return channel({ highestVoucherAmount: reads === 1 ? 25n : 30n, spent: 20n })
        },
        async updateChannel(_, fn) {
          return fn(await this.getChannel(channelId))
        },
        waitForUpdate(_channelId, signal) {
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                waiterAborted = true
                reject(signal.reason)
              },
              { once: true },
            )
          })
        },
      }

      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit() {},
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'test',
        store,
      })

      expect(waiterAborted).toBe(true)
    })

    test('reserveChargeOrWait preserves the waitForUpdate receiver', async () => {
      const store = memoryStore(channel({ highestVoucherAmount: 25n, spent: 20n }))
      store.waitForUpdate = async function () {
        expect(this).toBe(store)
        await this.updateChannel(channelId, (current) =>
          current ? { ...current, highestVoucherAmount: 30n } : current,
        )
      }

      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit() {},
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'test',
        store,
      })
    })

    function reservationStore(overrides: Partial<ChannelStore.State> = {}) {
      return memoryStore(
        channel({
          streamReservations: { test: { amount: 10n, units: 1, expiresAt: Date.now() + 30_000 } },
          ...overrides,
        }),
      )
    }

    test('commits only the owned reservation exactly once', async () => {
      const store = reservationStore()
      await commitReservedCharges({ channelId, store, reservationId: 'test' })
      expect(await store.getChannel(channelId)).toMatchObject({
        spent: 30n,
        units: 3,
        streamReservations: {},
      })
      expect(
        await commitReservedCharges({ channelId, store, reservationId: 'test' }),
      ).toBeUndefined()
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 30n, units: 3 })
    })

    test.each([
      [{ spent: 50n }, 'reserved voucher coverage'],
      [{ finalized: true }, 'finalized'],
      [{ closeRequestedAt: 1n }, 'pending close'],
      [{ streamReservations: { test: { amount: 10n, units: 1, expiresAt: 0 } } }, 'expired'],
    ] as const)('rejects unavailable reservations: %#', async (overrides, error) => {
      const store = reservationStore(overrides)
      await expect(
        commitReservedCharges({ channelId, store, reservationId: 'test' }),
      ).rejects.toThrow(error)
    })

    test('uses the final store retry to determine whether a charge committed', async () => {
      const available = await reservationStore().getChannel(channelId)
      const store: ChannelStore.ChannelStore = {
        async getChannel() {
          return channel()
        },
        async updateChannel(_, fn) {
          fn(available)
          return fn(channel())
        },
      }
      expect(
        await commitReservedCharges({ channelId, store, reservationId: 'test' }),
      ).toBeUndefined()
    })

    test('shares reservations across workers and excludes them from ordinary deductions', async () => {
      const store = memoryStore(channel({ spent: 40n }))
      const options = {
        channelId,
        amount: 10n,
        formatNeedVoucher,
        pollIntervalMs: 1,
        emit: vi.fn(),
        store,
      }
      await reserveChargeOrWait({ ...options, reservationId: 'first' })
      expect((await ChannelStore.deductFromChannel(store, channelId, 1n)).ok).toBe(false)
      const waiting = reserveChargeOrWait({
        ...options,
        store: { ...store },
        reservationId: 'second',
      })
      await vi.waitFor(() => expect(options.emit).toHaveBeenCalled())
      expect((await store.getChannel(channelId))?.streamReservations?.second).toBeUndefined()
      await releaseReservedCharges({ store, channelId, reservationId: 'first' })
      await waiting
      await commitReservedCharges({ store, channelId, reservationId: 'second' })
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 50n, units: 3 })
    })

    test('reclaims expired reservations and cannot renew them', async () => {
      const store = reservationStore({
        streamReservations: { test: { amount: 30n, units: 1, expiresAt: 0 } },
      })
      await expect(
        renewReservedCharges({ store, channelId, reservationId: 'test' }),
      ).rejects.toThrow('expired')
      await reserveChargeOrWait({
        store,
        channelId,
        reservationId: 'new',
        amount: 30n,
        emit() {},
        formatNeedVoucher,
        pollIntervalMs: 1,
      })
      expect((await store.getChannel(channelId))?.streamReservations?.test).toBeUndefined()
    })

    test('does not replace a lost reservation when adding another manual charge', async () => {
      const store = memoryStore(channel())
      await expect(
        reserveChargeOrWait({
          store,
          channelId,
          reservationId: 'lost',
          requireExisting: true,
          amount: 1n,
          emit() {},
          formatNeedVoucher,
          pollIntervalMs: 1,
        }),
      ).rejects.toThrow('reservation was lost')
    })

    test('retains a committed manual charge when canceled during generation', async () => {
      const store = memoryStore(channel())
      const controller = new AbortController()
      let finish!: () => void
      const gate = new Promise<void>((resolve) => {
        finish = resolve
      })
      const iterator = meterIterable({
        store,
        channelId,
        tickCost: 10n,
        pollIntervalMs: 1,
        signal: controller.signal,
        emitNeedVoucher() {},
        formatNeedVoucher,
        async *generate(stream) {
          await stream.charge()
          await gate
          yield 'late value'
        },
      })
      const next = iterator.next()
      await vi.waitFor(async () => expect((await store.getChannel(channelId))?.spent).toBe(30n))
      controller.abort()
      await vi.waitFor(async () =>
        expect(ChannelStore.reservedStreamAmount((await store.getChannel(channelId))!)).toBe(0n),
      )
      finish()
      expect(await next).toMatchObject({ done: true })
      expect((await store.getChannel(channelId))?.spent).toBe(30n)
    })

    test('does not start manual work before a failed charge commits', async () => {
      const store = memoryStore(channel())
      const update = store.updateChannel.bind(store)
      let attempts = 0
      vi.spyOn(store, 'updateChannel').mockImplementation(async (id, fn) => {
        if (++attempts === 2) throw new Error('commit failed')
        return update(id, fn)
      })
      const work = vi.fn()
      const iterator = meterIterable({
        store,
        channelId,
        tickCost: 10n,
        pollIntervalMs: 1,
        emitNeedVoucher() {},
        formatNeedVoucher,
        async *generate(stream) {
          await stream.charge()
          work()
          yield 'value'
        },
      })
      await expect(iterator.next()).rejects.toThrow('commit failed')
      expect(work).not.toHaveBeenCalled()
      expect(await store.getChannel(channelId)).toMatchObject({
        spent: 20n,
        streamReservations: {},
      })
    })

    test.each(['complete', 'throw', 'abort'] as const)(
      'retains manual charges on %s',
      async (outcome) => {
        const store = memoryStore(channel())
        const controller = new AbortController()
        const iterator = meterIterable({
          store,
          channelId,
          tickCost: 10n,
          pollIntervalMs: 1,
          signal: controller.signal,
          emitNeedVoucher() {},
          formatNeedVoucher,
          async *generate(stream) {
            await stream.charge()
            if (outcome === 'throw') throw new Error('generator failed')
            if (outcome === 'abort') controller.abort()
            yield* []
          },
        })
        if (outcome === 'throw') await expect(iterator.next()).rejects.toThrow('generator failed')
        else await iterator.next()
        expect(await store.getChannel(channelId)).toMatchObject({
          spent: 30n,
          streamReservations: {},
        })
      },
    )
  })
})

describe('SocketTransport', () => {
  class BrowserSocket {
    bufferedAmount = 0
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
    bufferedAmount = 0
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
        subscribe(
          { bufferedAmount: 0, close() {}, send() {} },
          { close() {}, error() {}, message() {} },
        ),
      ).toThrow('unsupported websocket implementation')
    })

    test('send supports sync and async socket implementations', async () => {
      const syncSocket = new BrowserSocket()
      const asyncSocket = {
        bufferedAmount: 0,
        close() {},
        sent: [] as string[],
        async send(data: string) {
          this.sent.push(data)
        },
      }

      await send(syncSocket, 'sync')
      await send(asyncSocket, 'async')
      await send({ close() {}, send() {} }, 'optional buffer')

      expect(syncSocket.sent).toEqual(['sync'])
      expect(asyncSocket.sent).toEqual(['async'])
    })

    test('send closes a socket before exceeding its outbound buffer limit', async () => {
      const close = vi.fn()
      const socket = {
        bufferedAmount: 8,
        close,
        send: vi.fn(),
      }

      await expect(send(socket, 'four', { maxBufferedAmount: 10 })).rejects.toThrow(
        'websocket outbound buffer limit exceeded',
      )

      expect(socket.send).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledWith(4008, 'outbound buffer limit exceeded')
    })

    test('serializes sends before checking buffered bytes', async () => {
      let release!: () => void
      const firstSend = new Promise<void>((resolve) => {
        release = resolve
      })
      const close = vi.fn()
      const socket = {
        bufferedAmount: 0,
        close,
        send: vi.fn(async () => {
          await firstSend
          socket.bufferedAmount = 6
        }),
      }

      const first = send(socket, '123456', { maxBufferedAmount: 10 })
      const second = send(socket, '123456', { maxBufferedAmount: 10 })
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce())
      release()

      await first
      await expect(second).rejects.toThrow('websocket outbound buffer limit exceeded')
      expect(socket.send).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledWith(4008, 'outbound buffer limit exceeded')
    })

    test('send uses a standards-compatible application close code', async () => {
      const close = vi.fn((code?: number) => {
        if (code !== 1000 && (code === undefined || code < 3000 || code > 4999))
          throw new DOMException('invalid close code', 'InvalidAccessError')
      })

      await expect(
        send({ bufferedAmount: 8, close, send() {} }, 'four', { maxBufferedAmount: 10 }),
      ).rejects.toThrow('websocket outbound buffer limit exceeded')
      expect(close).toHaveBeenCalledWith(4008, 'outbound buffer limit exceeded')
    })

    test('toText normalizes common message payloads', () => {
      expect(toText('hello')).toBe('hello')
      expect(toText(new TextEncoder().encode('bytes'))).toBe('bytes')
      expect(toText(new TextEncoder().encode('buffer').buffer)).toBe('buffer')
      expect(toText({ data: 'object' })).toBeNull()
    })
  })
})
