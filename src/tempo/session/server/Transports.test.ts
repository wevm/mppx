import type { Address, Hex } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import { ChannelClosedError } from '../../../Errors.js'
import * as Store from '../../../Store.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { meterIterable } from './MeteredStream.js'
import {
  commitReservedCharges,
  finalizeCommittedCharges,
  releaseReservedCharges,
  renewReservedCharges,
  reserveCharge,
  reserveChargeOrWait,
  send,
  subscribe,
  streamReservationTtlMs,
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
      async updateChannelResult(_channelId, fn) {
        const change = fn(state)
        if (change.op === 'set') state = change.value
        if (change.op === 'delete') state = null
        if (change.op !== 'noop') {
          for (const waiter of waiters) waiter()
          waiters.clear()
        }
        return change.result
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

  const activeReservation = (amount: bigint, units = 1) => ({
    amount,
    expiresAt: Number.MAX_SAFE_INTEGER,
    units,
  })

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
        reservationId: 'stream-1',
        store: memoryStore(channel()),
      })

      expect(emitted).toEqual([])
    })

    test('timestamps a reservation when its atomic update runs', async () => {
      const store = memoryStore(channel())
      const updateChannelResult = store.updateChannelResult!.bind(store)
      let updateStarted!: () => void
      const started = new Promise<void>((resolve) => {
        updateStarted = resolve
      })
      let releaseUpdate!: () => void
      const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve
      })
      store.updateChannelResult = async (...parameters) => {
        updateStarted()
        await updateGate
        return updateChannelResult(...parameters)
      }
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)

      try {
        const reservation = reserveCharge({
          amount: 10n,
          channelId,
          reservationId: 'stream-1',
          store,
        })
        await started
        clock.mockReturnValue(1_000 + streamReservationTtlMs + 1)
        releaseUpdate()
        await reservation

        expect(
          (await store.getChannel(channelId))?.streamReservations?.['stream-1']?.expiresAt,
        ).toBe(1_000 + streamReservationTtlMs * 2 + 1)
      } finally {
        releaseUpdate()
        clock.mockRestore()
      }
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
        reservationId: 'stream-1',
        store,
      })

      await expect.poll(() => emitted.length).toBe(1)
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
        reservationId: 'stream-1',
        store,
      })

      expect(emitted).toHaveLength(1)
    })

    test('cancels a store waiter when the polling timeout wins', async () => {
      let updates = 0
      let state = channel({ highestVoucherAmount: 25n, spent: 20n })
      let waiterAborted = false
      const store: ChannelStore.ChannelStore = {
        async getChannel() {
          return state
        },
        async updateChannel(_channelId, update) {
          updates += 1
          state = update({ ...state, highestVoucherAmount: updates === 1 ? 25n : 30n })!
          return state
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
        reservationId: 'stream-1',
        store,
      })

      expect(waiterAborted).toBe(true)
    })

    test('commitReservedCharges increments spend and units', async () => {
      const store = memoryStore(
        channel({
          spent: 20n,
          units: 2,
          highestVoucherAmount: 50n,
          streamReservations: { 'stream-1': activeReservation(10n) },
        }),
      )

      await commitReservedCharges({ channelId, reservationId: 'stream-1', store })

      expect(await store.getChannel(channelId)).toMatchObject({ spent: 30n, units: 3 })
      expect((await store.getChannel(channelId))?.streamReservations?.['stream-1']).toMatchObject({
        committed: true,
      })
      await finalizeCommittedCharges({ channelId, reservationId: 'stream-1', store })
      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()
    })

    test('bounds the lease for committed reservations left by terminated workers', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const store = memoryStore(
        channel({
          highestVoucherAmount: 50n,
          streamReservations: { 'stream-1': activeReservation(10n) },
        }),
      )

      try {
        await commitReservedCharges({ channelId, reservationId: 'stream-1', store })
        const committed = (await store.getChannel(channelId))!.streamReservations!['stream-1']!
        expect(committed.expiresAt).toBe(1_000 + streamReservationTtlMs)
        expect(
          ChannelStore.hasActiveStreamReservation(
            (await store.getChannel(channelId))!,
            committed.expiresAt,
          ),
        ).toBe(false)

        clock.mockReturnValue(committed.expiresAt)
        await reserveCharge({ amount: 1n, channelId, reservationId: 'stream-2', store })
        expect((await store.getChannel(channelId))?.streamReservations).toEqual({
          'stream-2': expect.objectContaining({ amount: 1n }),
        })
      } finally {
        clock.mockRestore()
      }
    })

    test('renews a committed reservation until transport delivery completes', async () => {
      vi.useFakeTimers({ now: 1_000 })
      const store = memoryStore(channel({ highestVoucherAmount: 50n }))
      const stream = meterIterable({
        channelId,
        emitNeedVoucher: () => {},
        formatNeedVoucher,
        generate: (async function* () {
          yield 'slow-send'
        })(),
        pollIntervalMs: 1,
        store,
        tickCost: 10n,
      })

      try {
        const item = await stream.next()
        if (item.done) throw new Error('expected a metered value')
        const before = (await store.getChannel(channelId))!.streamReservations![
          Object.keys((await store.getChannel(channelId))!.streamReservations!)[0]!
        ]!.expiresAt

        await vi.advanceTimersByTimeAsync(streamReservationTtlMs / 2)

        const reservation = Object.values(
          (await store.getChannel(channelId))!.streamReservations!,
        )[0]!
        expect(reservation.committed).toBe(true)
        expect(reservation.expiresAt).toBeGreaterThan(before)
        await item.value.delivered()
        await stream.return(undefined)
      } finally {
        vi.useRealTimers()
      }
    })

    test('releases instead of committing when cancellation wins a pending update', async () => {
      const store = memoryStore(
        channel({
          spent: 20n,
          units: 2,
          highestVoucherAmount: 50n,
          streamReservations: { 'stream-1': activeReservation(10n) },
        }),
      )
      const updateChannel = store.updateChannel.bind(store)
      let updateStarted!: () => void
      const started = new Promise<void>((resolve) => {
        updateStarted = resolve
      })
      let releaseUpdate!: () => void
      const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve
      })
      store.updateChannel = async (...parameters) => {
        updateStarted()
        await updateGate
        return updateChannel(...parameters)
      }
      const controller = new AbortController()
      const commit = commitReservedCharges({
        channelId,
        reservationId: 'stream-1',
        signal: controller.signal,
        store,
      })
      await started

      controller.abort(new Error('client disconnected'))
      releaseUpdate()

      await expect(commit).rejects.toThrow(/client disconnected/)
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 20n, units: 2 })
      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()
    })

    test('releases instead of committing when cancellation arrives during persistence', async () => {
      const memory = Store.memory()
      let gatePersistence = false
      let persistenceStarted!: () => void
      const started = new Promise<void>((resolve) => {
        persistenceStarted = resolve
      })
      let finishPersistence!: () => void
      const persistence = new Promise<void>((resolve) => {
        finishPersistence = resolve
      })
      const store = ChannelStore.fromStore({
        delete: memory.delete.bind(memory),
        get: memory.get.bind(memory),
        async put(key, value) {
          if (gatePersistence) {
            gatePersistence = false
            persistenceStarted()
            await persistence
          }
          await memory.put(key, value)
        },
      })
      await store.updateChannel(channelId, () =>
        channel({
          spent: 20n,
          units: 2,
          highestVoucherAmount: 50n,
          streamReservations: { 'stream-1': activeReservation(10n) },
        }),
      )
      gatePersistence = true
      const controller = new AbortController()
      const commit = commitReservedCharges({
        channelId,
        reservationId: 'stream-1',
        signal: controller.signal,
        store,
      })
      await started

      controller.abort(new Error('client disconnected'))
      let closeSawReservation = false
      const close = store.updateChannel(channelId, (current) => {
        closeSawReservation = ChannelStore.hasActiveStreamReservation(current!)
        return current
      })
      finishPersistence()

      await expect(commit).rejects.toThrow(/client disconnected/)
      await close
      expect(closeSawReservation).toBe(true)
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 20n, units: 2 })
      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()
    })

    test('commitReservedCharges rejects when reserved coverage is no longer available', async () => {
      await expect(
        commitReservedCharges({
          channelId,
          reservationId: 'stream-1',
          store: memoryStore(
            channel({
              spent: 20n,
              highestVoucherAmount: 50n,
              streamReservations: { 'stream-1': activeReservation(40n) },
            }),
          ),
        }),
      ).rejects.toThrow('reserved voucher coverage is no longer available')
    })

    test('uses the final store retry to determine whether a charge committed', async () => {
      const available = channel({
        spent: 20n,
        highestVoucherAmount: 50n,
        streamReservations: {
          'stream-1': { amount: 10n, units: 1, expiresAt: Number.MAX_SAFE_INTEGER },
        },
      })
      const unavailable = { ...available, spent: 50n }
      const store: ChannelStore.ChannelStore = {
        async getChannel() {
          return unavailable
        },
        async updateChannel(_channelId, fn) {
          fn(available)
          return fn(unavailable)
        },
      }

      await expect(
        commitReservedCharges({ channelId, reservationId: 'stream-1', store }),
      ).rejects.toThrow('reserved voucher coverage is no longer available')
    })

    test('commitReservedCharges rejects when the reservation was reclaimed', async () => {
      await expect(
        commitReservedCharges({
          channelId,
          reservationId: 'stream-1',
          store: memoryStore(channel({ highestVoucherAmount: 50n })),
        }),
      ).rejects.toThrow('stream reservation no longer exists')
    })

    test('commitReservedCharges rejects closed channels', async () => {
      await expect(
        commitReservedCharges({
          channelId,
          reservationId: 'stream-1',
          store: memoryStore(
            channel({
              finalized: true,
              streamReservations: { 'stream-1': activeReservation(10n) },
            }),
          ),
        }),
      ).rejects.toThrow(ChannelClosedError)
    })

    test('serializes reservations across concurrent streams', async () => {
      const emitted: string[] = []
      const store = memoryStore(channel({ highestVoucherAmount: 30n, spent: 20n }))

      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit(message) {
          emitted.push(message)
        },
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'stream-1',
        store,
      })
      const second = reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit(message) {
          emitted.push(message)
        },
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'stream-2',
        store,
      })

      await expect.poll(() => emitted.length).toBe(1)
      expect(emitted.map((message) => JSON.parse(message))).toEqual([
        {
          acceptedCumulative: '30',
          channelId,
          deposit: '100',
          requiredCumulative: '40',
        },
      ])
      expect((await store.getChannel(channelId))?.streamReservations).toEqual({
        'stream-1': expect.objectContaining({ amount: 10n, units: 1 }),
      })

      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 40n } : current,
      )
      await second
      expect((await store.getChannel(channelId))?.streamReservations).toEqual({
        'stream-1': expect.objectContaining({ amount: 10n, units: 1 }),
        'stream-2': expect.objectContaining({ amount: 10n, units: 1 }),
      })
    })

    test('releaseReservedCharges restores unused shared headroom', async () => {
      const store = memoryStore(
        channel({ streamReservations: { 'stream-1': activeReservation(10n) } }),
      )

      await releaseReservedCharges({ channelId, reservationId: 'stream-1', store })

      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()
    })

    test('does not renew an expired reservation', async () => {
      const store = memoryStore(
        channel({
          streamReservations: {
            'stream-1': { amount: 10n, expiresAt: Date.now() - 1, units: 1 },
          },
        }),
      )

      await renewReservedCharges({ channelId, reservationId: 'stream-1', store })

      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()
    })

    test('reclaims expired reservations left by terminated workers', async () => {
      const store = memoryStore(
        channel({
          highestVoucherAmount: 30n,
          streamReservations: {
            orphan: { amount: 10n, expiresAt: 0, units: 1 },
          },
        }),
      )

      await reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit: () => {},
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'replacement',
        store,
      })

      expect((await store.getChannel(channelId))?.streamReservations).toEqual({
        replacement: expect.objectContaining({ amount: 10n, units: 1 }),
      })
    })

    test('reclaims its own expired reservation before checking headroom', async () => {
      let needVoucher!: () => void
      const voucherRequested = new Promise<void>((resolve) => {
        needVoucher = resolve
      })
      const store = memoryStore(
        channel({
          highestVoucherAmount: 23n,
          spent: 20n,
          streamReservations: {
            'stream-1': { amount: 5n, expiresAt: 0, units: 1 },
          },
        }),
      )

      const pending = reserveChargeOrWait({
        amount: 6n,
        channelId,
        emit: needVoucher,
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'stream-1',
        store,
      })
      await voucherRequested
      expect((await store.getChannel(channelId))?.streamReservations).toBeUndefined()

      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 26n } : current,
      )
      await pending

      expect((await store.getChannel(channelId))?.streamReservations).toEqual({
        'stream-1': expect.objectContaining({ amount: 6n, units: 1 }),
      })
    })

    test('reserves and commits zero-cost stream units', async () => {
      const store = memoryStore(channel())

      await reserveChargeOrWait({
        amount: 0n,
        channelId,
        emit: () => {},
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'stream-1',
        store,
      })
      await commitReservedCharges({ channelId, reservationId: 'stream-1', store })
      await finalizeCommittedCharges({ channelId, reservationId: 'stream-1', store })

      expect(await store.getChannel(channelId)).toMatchObject({ spent: 20n, units: 3 })
    })

    test('rejects zero-cost stream units after the channel closes', async () => {
      await expect(
        reserveChargeOrWait({
          amount: 0n,
          channelId,
          emit: () => {},
          formatNeedVoucher,
          pollIntervalMs: 1,
          reservationId: 'stream-1',
          store: memoryStore(channel({ finalized: true })),
        }),
      ).rejects.toThrow(ChannelClosedError)
    })

    test('re-emits a larger requirement after losing a reservation race', async () => {
      const emitted: NeedVoucherEvent[] = []
      const store = memoryStore(channel({ highestVoucherAmount: 25n }), {
        waitForUpdate: true,
      })
      const reserve = (reservationId: string) =>
        reserveChargeOrWait({
          amount: 10n,
          channelId,
          emit(message) {
            emitted.push(JSON.parse(message))
          },
          formatNeedVoucher,
          pollIntervalMs: 5,
          reservationId,
          store,
        })

      const first = reserve('stream-1')
      const second = reserve('stream-2')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(emitted.filter((event) => event.requiredCumulative === '30')).toHaveLength(2)

      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 30n } : current,
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(emitted.some((event) => event.requiredCumulative === '40')).toBe(true)

      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 40n } : current,
      )
      await Promise.all([first, second])
    })

    test('re-emits a smaller requirement after reserved headroom is released', async () => {
      const emitted: NeedVoucherEvent[] = []
      const store = memoryStore(
        channel({
          highestVoucherAmount: 80n,
          spent: 80n,
          streamReservations: { other: activeReservation(15n) },
        }),
        { waitForUpdate: true },
      )
      const pending = reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit(message) {
          emitted.push(JSON.parse(message))
        },
        formatNeedVoucher,
        pollIntervalMs: 5,
        reservationId: 'stream-1',
        store,
      })

      await expect.poll(() => emitted.at(-1)?.requiredCumulative).toBe('105')
      await releaseReservedCharges({ channelId, reservationId: 'other', store })
      await expect.poll(() => emitted.at(-1)?.requiredCumulative).toBe('90')
      await store.updateChannel(channelId, (current) =>
        current ? { ...current, highestVoucherAmount: 90n } : current,
      )
      await pending
    })

    test('does not persist unchanged state while polling for headroom', async () => {
      let state: ChannelStore.State | null = channel({ highestVoucherAmount: 20n })
      let writes = 0
      const store: ChannelStore.ChannelStore = {
        async getChannel() {
          return state
        },
        async updateChannel(_channelId, fn) {
          state = fn(state)
          writes += 1
          return state
        },
        async updateChannelResult(_channelId, fn) {
          const change = fn(state)
          if (change.op === 'set') {
            state = change.value
            writes += 1
          } else if (change.op === 'delete') {
            state = null
            writes += 1
          }
          return change.result
        },
      }
      const controller = new AbortController()
      const pending = reserveChargeOrWait({
        amount: 10n,
        channelId,
        emit: () => {},
        formatNeedVoucher,
        pollIntervalMs: 1,
        reservationId: 'stream-1',
        signal: controller.signal,
        store,
      })

      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort(new Error('stop'))
      await expect(pending).rejects.toThrow('stop')
      expect(writes).toBe(0)
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
