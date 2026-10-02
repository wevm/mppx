import type { Address, Hex } from 'viem'
import { describe, expect, test, vi } from 'vp/test'

import { ChannelClosedError } from '../../../Errors.js'
import { chainId, escrowContract as escrowContractDefaults } from '../../internal/defaults.js'
import type { NeedVoucherEvent, SessionReceipt } from '../precompile/Protocol.js'
import type * as ChannelStore from './ChannelStore.js'
import {
  formatNeedVoucherEvent,
  formatReceiptEvent,
  iterateData,
  parseEvent,
  serve,
} from './Sse.js'
import { reserveCharge, streamReservationTtlMs } from './Transports.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'challenge-1'

describe('iterateData', () => {
  test.each([
    ['LF', 'data: one\n\ndata: two\n\n'],
    ['CRLF', 'data: one\r\n\r\ndata: two\r\n\r\n'],
    ['CR', 'data: one\r\rdata: two\r\r'],
  ])('parses %s event boundaries', async (_, input) => {
    const response = new Response(input)
    const values: string[] = []

    for await (const value of iterateData(response)) values.push(value)

    expect(values).toEqual(['one', 'two'])
  })

  test('parses a CRLF boundary split across chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\r'))
        controller.enqueue(encoder.encode('\n\r'))
        controller.enqueue(encoder.encode('\ndata: two\r\n\r\n'))
        controller.close()
      },
    })
    const values: string[] = []

    for await (const value of iterateData(new Response(stream))) values.push(value)

    expect(values).toEqual(['one', 'two'])
  })
})

describe('formatReceiptEvent', () => {
  test('produces valid SSE format', () => {
    const receipt: SessionReceipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: '2025-01-01T00:00:00.000Z',
      reference: channelId,
      challengeId,
      channelId,
      acceptedCumulative: '1000000',
      spent: '0',
      units: 1,
    }

    const event = formatReceiptEvent(receipt)

    expect(event).toMatch(/^event: payment-receipt\n/)
    expect(event).toMatch(/\ndata: \{.*\}\n\n$/)
    expect(event).toBe(`event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`)
  })

  test('includes txHash when present', () => {
    const receipt: SessionReceipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: '2025-01-01T00:00:00.000Z',
      reference: channelId,
      challengeId,
      channelId,
      acceptedCumulative: '5000000',
      spent: '1000000',
      units: 3,
      txHash: '0xabcdef',
    }

    const event = formatReceiptEvent(receipt)
    const data = JSON.parse(event.split('data: ')[1]!.trim())
    expect(data.txHash).toBe('0xabcdef')
  })
})

describe('formatNeedVoucherEvent', () => {
  test('produces valid SSE format with payment-need-voucher event type', () => {
    const params: NeedVoucherEvent = {
      channelId,
      requiredCumulative: '6000000',
      acceptedCumulative: '5000000',
      deposit: '10000000',
    }

    const event = formatNeedVoucherEvent(params)

    expect(event).toMatch(/^event: payment-need-voucher\n/)
    expect(event).toMatch(/\ndata: \{.*\}\n\n$/)
    expect(event).toBe(`event: payment-need-voucher\ndata: ${JSON.stringify(params)}\n\n`)
  })

  test('data is valid JSON with all fields', () => {
    const params: NeedVoucherEvent = {
      channelId,
      requiredCumulative: '3500000',
      acceptedCumulative: '3000000',
      deposit: '10000000',
    }

    const event = formatNeedVoucherEvent(params)
    const data = JSON.parse(event.split('data: ')[1]!.trim())

    expect(data.channelId).toBe(channelId)
    expect(data.requiredCumulative).toBe('3500000')
    expect(data.acceptedCumulative).toBe('3000000')
  })
})

describe('parseEvent', () => {
  test('parses message event (default type)', () => {
    const raw = 'data: hello world\n\n'
    const event = parseEvent(raw)

    expect(event).toEqual({ type: 'message', data: 'hello world' })
  })

  test('parses explicit message event', () => {
    const raw = 'event: message\ndata: hello\n\n'
    const event = parseEvent(raw)

    expect(event).toEqual({ type: 'message', data: 'hello' })
  })

  test('parses payment-need-voucher event', () => {
    const params: NeedVoucherEvent = {
      channelId,
      requiredCumulative: '6000000',
      acceptedCumulative: '5000000',
      deposit: '10000000',
    }
    const raw = `event: payment-need-voucher\ndata: ${JSON.stringify(params)}\n\n`
    const event = parseEvent(raw)

    expect(event).toEqual({ type: 'payment-need-voucher', data: params })
  })

  test('parses payment-receipt event', () => {
    const receipt: SessionReceipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: '2025-01-01T00:00:00.000Z',
      reference: channelId,
      challengeId,
      channelId,
      acceptedCumulative: '5000000',
      spent: '3000000',
      units: 3,
    }
    const raw = `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`
    const event = parseEvent(raw)

    expect(event).toEqual({ type: 'payment-receipt', data: receipt })
  })

  test('returns null for empty or comment-only input', () => {
    expect(parseEvent('')).toBeNull()
    expect(parseEvent(': this is a comment')).toBeNull()
  })

  test('round-trips formatReceiptEvent', () => {
    const receipt: SessionReceipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: '2025-01-01T00:00:00.000Z',
      reference: channelId,
      challengeId,
      channelId,
      acceptedCumulative: '1000000',
      spent: '500000',
      units: 2,
    }
    const formatted = formatReceiptEvent(receipt)
    const parsed = parseEvent(formatted)

    expect(parsed).toEqual({ type: 'payment-receipt', data: receipt })
  })

  test('round-trips formatNeedVoucherEvent', () => {
    const params: NeedVoucherEvent = {
      channelId,
      requiredCumulative: '6000000',
      acceptedCumulative: '5000000',
      deposit: '10000000',
    }
    const formatted = formatNeedVoucherEvent(params)
    const parsed = parseEvent(formatted)

    expect(parsed).toEqual({ type: 'payment-need-voucher', data: params })
  })

  test('treats unknown event types as message', () => {
    const raw = 'event: custom-type\ndata: some-data\n\n'
    const event = parseEvent(raw)

    expect(event).toEqual({ type: 'message', data: 'some-data' })
  })
})

describe('serve', () => {
  function memoryStore(): ChannelStore.ChannelStore {
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

  async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let result = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
    return result
  }

  async function* generate(values: string[]): AsyncGenerator<string> {
    for (const v of values) yield v
  }

  function seedChannel(
    storage: ChannelStore.ChannelStore,
    balance: bigint,
  ): Promise<ChannelStore.State | null> {
    return storage.updateChannel(channelId, () => ({
      channelId,
      payer: '0x0000000000000000000000000000000000000001' as Address,
      payee: '0x0000000000000000000000000000000000000002' as Address,
      token: '0x0000000000000000000000000000000000000003' as Address,
      authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
      chainId: 42431,
      escrowContract: escrowContractDefaults[chainId.testnet] as Address,
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

  test('emits message events for each generated value', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 3000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['hello', 'world', 'done']),
    })

    const output = await readStream(stream)

    expect(output).toContain('event: message\ndata: hello\n\n')
    expect(output).toContain('event: message\ndata: world\n\n')
    expect(output).toContain('event: message\ndata: done\n\n')
    expect(output).toContain('event: payment-receipt\n')

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(3000000n)
    expect(channel!.units).toBe(3)
  })

  test('uses a prepaid unit for the first generated value', async () => {
    const storage = memoryStore()
    const committed: Array<{ spent: bigint; units: number }> = []
    await seedChannel(storage, 3000000n)
    await storage.updateChannel(channelId, (current) =>
      current ? { ...current, spent: 1000000n, units: 1 } : current,
    )

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['hello', 'world']),
      onChargeCommitted(channel) {
        committed.push({ spent: channel.spent, units: channel.units })
      },
      prepaidUnits: 1,
    })

    const output = await readStream(stream)
    expect(output).toContain('event: message\ndata: hello\n\n')
    expect(output).toContain('event: message\ndata: world\n\n')

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(2000000n)
    expect(channel!.units).toBe(2)
    expect(committed).toEqual([{ spent: 2000000n, units: 2 }])
  })

  test('does not persist state for prepaid or manually uncharged values', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)
    let updates = 0
    const updateChannel = storage.updateChannel.bind(storage)
    storage.updateChannel = async (...parameters) => {
      updates++
      return updateChannel(...parameters)
    }

    await readStream(
      serve({
        store: storage,
        channelId,
        challengeId,
        tickCost: 1000000n,
        generate: async function* (stream) {
          await stream.charge()
          yield 'prepaid'
          yield 'uncharged'
        },
        prepaidUnits: 1,
      }),
    )

    expect(updates).toBe(0)
  })

  test('uses the provided amount for an explicit charge when a prepaid unit exists', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 4015n)
    await storage.updateChannel(channelId, (current) =>
      current ? { ...current, spent: 1n, units: 1 } : current,
    )

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1n,
      generate: async function* (stream) {
        await stream.charge(4014n)
        yield 'charged'
      },
      prepaidUnits: 1,
    })

    await readStream(stream)

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(4015n)
    expect(channel!.units).toBe(2)
  })

  test('replaces a reserved response tick with an explicit manual charge', async () => {
    const storage = memoryStore()
    const reservationId = 'response'
    await seedChannel(storage, 4015n)
    await reserveCharge({ amount: 1n, channelId, reservationId, store: storage })

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1n,
      generate: async function* (stream) {
        await stream.charge(4014n)
        yield 'charged'
      },
      reservationId,
      reservedUnits: 1,
    })

    await readStream(stream)

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(4014n)
    expect(channel!.units).toBe(1)
  })

  test('does not reuse a reserved unit after its reservation is committed', async () => {
    const storage = memoryStore()
    const reservationId = 'response'
    await seedChannel(storage, 2n)
    await reserveCharge({ amount: 1n, channelId, reservationId, store: storage })

    await readStream(
      serve({
        store: storage,
        channelId,
        challengeId,
        tickCost: 1n,
        generate: async function* (stream) {
          yield 'reserved'
          await stream.charge()
          yield 'new charge'
        },
        reservationId,
        reservedUnits: 1,
      }),
    )

    const channel = await storage.getChannel(channelId)
    expect(channel?.spent).toBe(2n)
    expect(channel?.units).toBe(2)
  })

  test('commits zero-cost units before emitting stream values', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 0n)

    await readStream(
      serve({
        store: storage,
        channelId,
        challengeId,
        tickCost: 0n,
        generate: (async function* () {
          yield 'first'
          yield 'second'
        })(),
      }),
    )

    const channel = await storage.getChannel(channelId)
    expect(channel).toMatchObject({ spent: 0n, units: 2 })
    expect(channel?.streamReservations).toBeUndefined()
  })

  test('renews an existing response reservation until the first emitted value', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') })
    try {
      const storage = memoryStore()
      const reservationId = 'response'
      await seedChannel(storage, 1n)
      await reserveCharge({ amount: 1n, channelId, reservationId, store: storage })
      const updateChannel = storage.updateChannel.bind(storage)
      let renewalFailed = false
      storage.updateChannel = async (...parameters) => {
        if (!renewalFailed) {
          renewalFailed = true
          throw new Error('transient renewal failure')
        }
        return updateChannel(...parameters)
      }
      let releaseFirstValue!: () => void
      const firstValue = new Promise<void>((resolve) => {
        releaseFirstValue = resolve
      })
      const output = readStream(
        serve({
          store: storage,
          channelId,
          challengeId,
          tickCost: 1n,
          generate: async function* () {
            await firstValue
            yield 'delayed'
          },
          reservationId,
          reservedUnits: 1,
        }),
      )

      await vi.advanceTimersByTimeAsync(streamReservationTtlMs + 1)
      const reservation = (await storage.getChannel(channelId))?.streamReservations?.[reservationId]
      expect(reservation?.expiresAt).toBeGreaterThan(Date.now())

      releaseFirstValue()
      await expect(output).resolves.toContain('event: message\ndata: delayed\n\n')
      expect(await storage.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  test('releases an existing response reservation when the reader cancels', async () => {
    const storage = memoryStore()
    const reservationId = 'response'
    await seedChannel(storage, 1n)
    await reserveCharge({ amount: 1n, channelId, reservationId, store: storage })
    let releaseFirstValue!: () => void
    const firstValue = new Promise<void>((resolve) => {
      releaseFirstValue = resolve
    })
    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1n,
      generate: async function* () {
        await firstValue
        yield 'late'
      },
      reservationId,
      reservedUnits: 1,
    }).getReader()

    await Promise.resolve()
    await reader.cancel('client disconnected')

    await expect
      .poll(async () => (await storage.getChannel(channelId))?.streamReservations?.[reservationId])
      .toBeUndefined()
    releaseFirstValue()
  })

  test('releases headroom reserved concurrently with reader cancellation', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1n)
    const updateChannel = storage.updateChannel.bind(storage)
    let reservationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reservationStarted = resolve
    })
    let finishReservation!: () => void
    const reservationGate = new Promise<void>((resolve) => {
      finishReservation = resolve
    })
    let firstUpdate = true
    storage.updateChannel = async (...parameters) => {
      if (firstUpdate) {
        firstUpdate = false
        reservationStarted()
        await reservationGate
      }
      return updateChannel(...parameters)
    }
    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1n,
      generate: generate(['late']),
    }).getReader()
    const read = reader.read()
    await started

    const canceled = reader.cancel('client disconnected')
    finishReservation()
    await canceled
    await expect(read).resolves.toMatchObject({ done: true })

    await expect.poll(() => storage.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
    expect((await storage.getChannel(channelId))?.streamReservations).toBeUndefined()
  })

  test('runs the post-commit hook after delivering each charged value', async () => {
    const storage = memoryStore()
    const committed: Array<{ spent: bigint; units: number }> = []
    await seedChannel(storage, 2000000n)

    const output = await readStream(
      serve({
        store: storage,
        channelId,
        challengeId,
        tickCost: 1000000n,
        generate: generate(['first', 'second']),
        onChargeCommitted(channel) {
          committed.push({ spent: channel.spent, units: channel.units })
        },
      }),
    )

    expect(output).toContain('event: message\ndata: first\n\n')
    expect(output).toContain('event: message\ndata: second\n\n')
    expect(committed).toEqual([
      { spent: 1000000n, units: 1 },
      { spent: 2000000n, units: 2 },
    ])
  })

  test('reports a post-commit hook failure after delivering the charged value', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['blocked']),
      onChargeCommitted() {
        throw new Error('settlement failed')
      },
    }).getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('event: message\ndata: blocked\n\n')
    await expect(reader.read()).rejects.toThrow('settlement failed')
    const channel = await storage.getChannel(channelId)
    expect(channel).toMatchObject({ spent: 1000000n, units: 1 })
  })

  test('keeps a delivered charge when cancellation arrives during the post-commit hook', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)
    let hookStarted!: () => void
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve
    })
    let finishHook!: () => void
    const hook = new Promise<void>((resolve) => {
      finishHook = resolve
    })
    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['delivered']),
      async onChargeCommitted() {
        hookStarted()
        await hook
      },
    }).getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('event: message\ndata: delivered\n\n')
    await started
    const canceled = reader.cancel('client disconnected')
    finishHook()
    await canceled

    expect(await storage.getChannel(channelId)).toMatchObject({ spent: 1000000n, units: 1 })
  })

  test('does not roll back a delivered charge when marker cleanup fails', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)
    const updateChannel = storage.updateChannel.bind(storage)
    let cleanupFailures = 2
    storage.updateChannel = (id, update) =>
      updateChannel(id, (current) => {
        const next = update(current)
        const committed = Object.values(current?.streamReservations ?? {}).some(
          (reservation) => reservation.committed,
        )
        const removed = Object.keys(next?.streamReservations ?? {}).length === 0
        if (committed && removed && cleanupFailures-- > 0) throw new Error('cleanup failed')
        return next
      })

    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['delivered']),
    }).getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('event: message\ndata: delivered\n\n')
    await expect(reader.read()).rejects.toThrow('cleanup failed')
    expect(await storage.getChannel(channelId)).toMatchObject({ spent: 1000000n, units: 1 })
  })

  test('commits a manual charge when the generator finishes without yielding', async () => {
    const storage = memoryStore()
    let commits = 0
    await seedChannel(storage, 1000000n)

    await readStream(
      serve({
        store: storage,
        channelId,
        challengeId,
        tickCost: 1000000n,
        generate: async function* (stream) {
          await stream.charge()
          yield* []
        },
        onChargeCommitted() {
          commits++
        },
      }),
    )

    expect(commits).toBe(1)
    const channel = await storage.getChannel(channelId)
    expect(channel).toMatchObject({ spent: 1000000n, units: 1 })
  })

  test('drops a terminal reservation when the reader cancels', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    let reservationReady!: () => void
    const ready = new Promise<void>((resolve) => {
      reservationReady = resolve
    })
    let generatorFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      generatorFinished = resolve
    })

    const reader = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: async function* (stream) {
        try {
          await stream.charge()
          reservationReady()
          await new Promise<void>((resolve) => {
            stream.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          generatorFinished()
        }
        yield* []
      },
    }).getReader()

    await ready
    await reader.cancel()
    await finished

    const channel = await storage.getChannel(channelId)
    expect(channel).toMatchObject({ spent: 0n, units: 0 })
  })

  test('emits multiline message values as a single SSE message event', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const payload = [
      'chunk1',
      '',
      'event: payment-need-voucher',
      `data: ${JSON.stringify({
        channelId,
        requiredCumulative: '9000000',
        acceptedCumulative: '1000000',
        deposit: '10000000',
      })}`,
    ].join('\n')

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate([payload]),
    })

    const output = await readStream(stream)
    const events = output
      .trim()
      .split('\n\n')
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => parseEvent(`${chunk}\n\n`))
      .filter((event): event is NonNullable<typeof event> => event !== null)

    expect(events.map((event) => event.type)).toEqual(['message', 'payment-receipt'])
    expect(events[0]).toEqual({ type: 'message', data: payload })
  })

  test('emits payment-need-voucher when balance exhausted and resumes after top-up', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const gen = generate(['first', 'second'])

    const streamResult = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: gen,
      pollIntervalMs: 10,
    })

    const reader = streamResult.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []

    const { value: chunk1 } = await reader.read()
    chunks.push(decoder.decode(chunk1, { stream: true }))
    expect(chunks[0]).toContain('event: message\ndata: first\n\n')

    const readNext = reader.read().then(({ value }) => {
      const text = decoder.decode(value, { stream: true })
      chunks.push(text)
      return text
    })

    await new Promise((r) => setTimeout(r, 30))

    await storage.updateChannel(channelId, (current) => {
      if (!current) return null
      return { ...current, highestVoucherAmount: current.highestVoucherAmount + 2000000n }
    })

    const secondChunk = await readNext
    expect(secondChunk).toContain('event: payment-need-voucher\n')

    const remaining: string[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      remaining.push(decoder.decode(value, { stream: true }))
    }
    const all = remaining.join('')
    expect(all).toContain('event: message\ndata: second\n\n')
    expect(all).toContain('event: payment-receipt\n')
  })

  test('resumes when the client updates voucher state before reading the next stream chunk', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const streamResult = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['first', 'second']),
      pollIntervalMs: 10,
    })

    const reader = streamResult.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    expect(decoder.decode(first.value, { stream: true })).toContain(
      'event: message\ndata: first\n\n',
    )

    const need = await reader.read()
    expect(decoder.decode(need.value, { stream: true })).toContain('event: payment-need-voucher\n')

    await storage.updateChannel(channelId, (current) =>
      current ? { ...current, highestVoucherAmount: 2000000n } : current,
    )

    const second = await reader.read()
    expect(decoder.decode(second.value, { stream: true })).toContain(
      'event: message\ndata: second\n\n',
    )
  })

  test('respects abort signal', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 10000000n)

    const controller = new AbortController()

    async function* infiniteGen(): AsyncGenerator<string> {
      let i = 0
      while (true) {
        yield `chunk-${i++}`
        await new Promise((r) => setTimeout(r, 5))
      }
    }

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: infiniteGen(),
      signal: controller.signal,
    })

    const reader = stream.getReader()
    const decoder = new TextDecoder()

    const { value: first } = await reader.read()
    expect(decoder.decode(first)).toContain('event: message\ndata: chunk-0\n\n')

    controller.abort()

    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  })

  test('emits receipt with correct spent and units', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 2000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['a', 'b']),
    })

    const output = await readStream(stream)
    const receiptRaw = output.split('event: payment-receipt\ndata: ')[1]?.split('\n\n')[0]
    const receipt = JSON.parse(receiptRaw!)

    expect(receipt.spent).toBe('2000000')
    expect(receipt.units).toBe(2)
    expect(receipt.channelId).toBe(channelId)
    expect(receipt.challengeId).toBe(challengeId)
  })

  test('emits exactly one terminal payment-receipt event at stream end', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 2000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['one', 'two']),
    })

    const output = await readStream(stream)
    const events = output
      .trim()
      .split('\n\n')
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => parseEvent(`${chunk}\n\n`))
      .filter((event): event is NonNullable<typeof event> => event !== null)

    const terminal = events.at(-1)
    expect(terminal?.type).toBe('payment-receipt')
    if (terminal?.type !== 'payment-receipt') throw new Error('expected terminal payment receipt')

    expect(events.filter((event) => event.type === 'payment-receipt')).toHaveLength(1)
    expect(terminal.data.challengeId).toBe(challengeId)
    expect(terminal.data.channelId).toBe(channelId)
    expect(terminal.data.units).toBe(2)
    expect(terminal.data.spent).toBe('2000000')
  })

  test('handles empty generator', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate([]),
    })

    const output = await readStream(stream)
    expect(output).toContain('event: payment-receipt\n')
    expect(output).not.toContain('event: message\n')

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(0n)
    expect(channel!.units).toBe(0)
  })

  test('throws when channel does not exist', async () => {
    const storage = memoryStore()

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['hello']),
    })

    const reader = stream.getReader()
    await expect(reader.read()).rejects.toThrow('channel not found')
  })

  test('rejects a reserved charge when channel close is requested before commit', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: async function* (stream) {
        await stream.charge()
        await storage.updateChannel(channelId, (current) =>
          current ? { ...current, closeRequestedAt: 1n } : null,
        )
        yield 'blocked'
      },
    })

    const reader = stream.getReader()
    await expect(reader.read()).rejects.toThrow(ChannelClosedError)

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(0n)
    expect(channel!.units).toBe(0)
  })
})
