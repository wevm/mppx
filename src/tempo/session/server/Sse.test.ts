import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import { ChannelClosedError } from '../../../Errors.js'
import { chainId, escrowContract as escrowContractDefaults } from '../../internal/defaults.js'
import type { NeedVoucherEvent, SessionReceipt } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  formatNeedVoucherEvent,
  formatReceiptEvent,
  iterateData,
  parseEvent,
  PrepaidRefundError,
  preparePrepaidRefund,
  maxPrepaidRefunds,
  type PrepaidRefund,
  serve,
} from './Sse.js'

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

  test('does not exhaust the generator before the response is consumed', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 3n)
    let produced = 0
    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1n,
      generate: async function* () {
        for (const value of ['first', 'second', 'third']) {
          produced++
          yield value
        }
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(produced).toBeLessThan(3)

    await readStream(stream)
    expect(produced).toBe(3)
  })

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

  test('emits the final receipt without another escrow check after all charges were delivered', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 3000000n)
    let delivered = false
    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      beforeCharge() {
        if (delivered) throw new Error('escrow unavailable after delivery')
      },
      generate: async function* (stream) {
        await stream.charge()
        yield 'paid content'
        delivered = true
      },
    })
    const output = await readStream(stream)
    expect(output).toContain('data: paid content')
    expect(output).toContain('event: payment-receipt')
    expect((await storage.getChannel(channelId))!.spent).toBe(1000000n)
  })

  test.each(['generator', 'first check', 'delivery check'] as const)(
    'credits an unsettled prepaid item after failure in %s',
    async (failure) => {
      const store = memoryStore()
      await seedChannel(store, 10n)
      await store.updateChannel(channelId, (current) => ({ ...current!, spent: 1n, units: 1 }))
      let checks = 0
      const stream = serve({
        store,
        channelId,
        challengeId,
        tickCost: 1n,
        autoCreditPrepaid: true,
        prepaidUnits: 1,
        beforeCharge() {
          checks++
          if (checks === (failure === 'first check' ? 1 : 2)) throw new Error('delivery failed')
        },
        generate: (async function* () {
          if (failure === 'generator') throw new Error('delivery failed')
          yield 'not delivered'
        })(),
      })
      await expect(readStream(stream)).rejects.toThrow('delivery failed')
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
    },
  )

  test.each([
    { settledOnChain: 1n, reason: 'belowSettled' },
    { closeRequestedAt: 1n, reason: 'closing' },
    { finalized: true, settledOnChain: 1n, reason: 'finalized' },
  ])('requests merchant reconciliation when credit is $reason', async ({ reason, ...state }) => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({
      ...current!,
      spent: 1n,
      units: 1,
      ...state,
    }))
    const refunds: PrepaidRefund[] = []
    await expect(
      readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          autoCreditPrepaid: true,
          prepaidUnits: 1,
          refundIdempotencyKey: 'prepaid-request',
          generate: generate(['blocked']),
          beforeCharge() {
            throw new Error('delivery failed')
          },
          onRefundRequired(refund) {
            refunds.push(refund)
          },
        }),
      ),
    ).rejects.toThrow('delivery failed')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({
      channelId,
      amount: 1n,
      units: 1,
      idempotencyKey: 'prepaid-request',
      credit: { status: 'declined', reason },
    })
    expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
  })

  test.each([0n, 1n])(
    'retains a manually consumed prepaid unit when generation fails (settled=%s)',
    async (settledOnChain) => {
      const store = memoryStore()
      await seedChannel(store, 10n)
      await store.updateChannel(channelId, (current) => ({
        ...current!,
        spent: 1n,
        units: 1,
        settledOnChain,
      }))
      let refunds = 0
      await expect(
        readStream(
          serve({
            store,
            channelId,
            challengeId,
            tickCost: 1n,
            autoCreditPrepaid: true,
            prepaidUnits: 1,
            generate: async function* (stream) {
              await stream.charge()
              yield await Promise.reject(new Error('billable work failed'))
            },
            onRefundRequired() {
              refunds++
            },
          }),
        ),
      ).rejects.toThrow('billable work failed')
      expect(refunds).toBe(0)
      expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
    },
  )

  test('does not count a manually consumed prepaid unit twice when it is delivered', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 2n, units: 2 }))
    const reader = serve({
      store,
      channelId,
      challengeId,
      tickCost: 1n,
      autoCreditPrepaid: true,
      prepaidUnits: 2,
      generate: async function* (stream) {
        await stream.charge()
        yield 'paid'
        throw new Error('later failure')
      },
    }).getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow('later failure')
    expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
  })

  test('does not credit an already delivered prepaid item after a later failure', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 1n, units: 1 }))
    const reader = serve({
      store,
      channelId,
      challengeId,
      tickCost: 1n,
      autoCreditPrepaid: true,
      prepaidUnits: 1,
      generate: (async function* () {
        yield 'delivered'
        throw new Error('later failure')
      })(),
    }).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('delivered')
    await expect(reader.read()).rejects.toThrow('later failure')
    expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
  })

  test('retries a failed prepaid credit idempotently', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 2n, units: 2 }))
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        readStream(
          serve({
            store,
            channelId,
            challengeId,
            tickCost: 1n,
            autoCreditPrepaid: true,
            prepaidUnits: 1,
            refundIdempotencyKey: 'same-charge',
            generate: generate(['blocked']),
            beforeCharge() {
              throw new Error('delivery failed')
            },
          }),
        ),
      ).rejects.toThrow('delivery failed')
    }
    expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
  })

  test('reports ambiguous credits without requesting a definite external refund', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 10n)
    await storage.updateChannel(channelId, (current) => ({ ...current!, spent: 1n, units: 1 }))
    let failed = false
    const store: ChannelStore.ChannelStore = {
      ...storage,
      async updateChannel(id, fn) {
        const result = await storage.updateChannel(id, fn)
        if (
          Object.keys(result?.idempotencyMarkers ?? {}).some((key) => key.startsWith('credit:')) &&
          !failed
        ) {
          failed = true
          throw new Error('write acknowledged late')
        }
        return result
      },
    }
    const refunds: PrepaidRefund[] = []
    await expect(
      readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          autoCreditPrepaid: true,
          prepaidUnits: 1,
          generate: generate(['blocked']),
          beforeCharge() {
            throw new Error('delivery failed')
          },
          onRefundRequired(refund) {
            refunds.push(refund)
          },
        }),
      ),
    ).rejects.toThrow('delivery failed')
    expect(refunds[0]?.credit).toMatchObject({ status: 'unknown', error: expect.any(Error) })
    expect(await storage.getChannel(channelId)).toMatchObject({ spent: 0n, units: 0 })
  })

  test.each([false, true])(
    'preserves refund retry data when the merchant hook fails or is absent: %s',
    async (hook) => {
      const store = memoryStore()
      await seedChannel(store, 10n)
      await store.updateChannel(channelId, (current) => ({
        ...current!,
        spent: 1n,
        units: 1,
        settledOnChain: 1n,
      }))
      const error = await readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          autoCreditPrepaid: true,
          prepaidUnits: 1,
          generate: generate(['blocked']),
          beforeCharge() {
            throw new Error('delivery failed')
          },
          ...(hook
            ? {
                onRefundRequired() {
                  throw new Error('queue unavailable')
                },
              }
            : {}),
        }),
      ).catch((error: AggregateError) => error)
      expect(error).toBeInstanceOf(AggregateError)
      const failure = (error as AggregateError).errors.find(
        (error) => error instanceof PrepaidRefundError,
      )
      expect(failure!.refund).toMatchObject({
        channelId,
        amount: 1n,
        units: 1,
        credit: { status: 'declined' },
      })
      expect(failure!.refund.idempotencyKey).toMatch(/^stream:/)
      expect(
        (await store.getChannel(channelId))?.prepaidRefunds?.[failure!.refund.idempotencyKey],
      ).toMatchObject({
        amount: '1',
        units: 1,
        status: 'failed',
      })
    },
  )

  test('leaves merchant-owned refunds alone unless automatic credits are enabled', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 2n, units: 2 }))
    await expect(
      readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          prepaidUnits: 1,
          generate: (async function* () {
            await ChannelStore.creditChannel(store, channelId, 1n, {
              idempotencyKey: 'merchant',
              units: 1,
            })
            yield await Promise.reject(new Error('merchant refunded'))
          })(),
        }),
      ),
    ).rejects.toThrow('merchant refunded')
    expect(await store.getChannel(channelId)).toMatchObject({ spent: 1n, units: 1 })
  })

  test.each([0n, 1n, 2n])(
    'only requests the captured portion of finalized failed delivery: %s',
    async (settledOnChain) => {
      const store = memoryStore()
      await seedChannel(store, 10n)
      await store.updateChannel(channelId, (current) => ({
        ...current!,
        spent: 3n,
        units: 3,
        finalized: true,
        settledOnChain,
      }))
      const refunds: PrepaidRefund[] = []
      await expect(
        readStream(
          serve({
            store,
            channelId,
            challengeId,
            tickCost: 2n,
            prepaidUnits: 1,
            autoCreditPrepaid: true,
            generate: generate(['blocked']),
            beforeCharge() {
              throw new Error('closed')
            },
            onRefundRequired(refund) {
              refunds.push(refund)
            },
          }),
        ),
      ).rejects.toThrow('closed')
      expect(refunds).toHaveLength(settledOnChain <= 1n ? 0 : 1)
      if (refunds.length) expect(refunds[0]).toMatchObject({ amount: 2n, externalRefundAmount: 1n })
      expect((await store.getChannel(channelId))?.prepaidRefunds).toEqual({})
    },
  )

  test('rejects an empty refund key before streaming', () => {
    expect(() =>
      serve({
        store: memoryStore(),
        channelId,
        challengeId,
        tickCost: 1n,
        prepaidUnits: 1,
        autoCreditPrepaid: true,
        refundIdempotencyKey: '',
        generate: generate([]),
      }),
    ).toThrow('non-empty string')
  })

  test('reports a definite conflicting credit separately from an uncertain write', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 4n, units: 4 }))
    await ChannelStore.creditChannel(store, channelId, 2n, { idempotencyKey: 'conflict', units: 2 })
    const refunds: PrepaidRefund[] = []
    await expect(
      readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          prepaidUnits: 1,
          autoCreditPrepaid: true,
          refundIdempotencyKey: 'conflict',
          generate: generate(['blocked']),
          beforeCharge() {
            throw new Error('blocked')
          },
          onRefundRequired(refund) {
            refunds.push(refund)
          },
        }),
      ),
    ).rejects.toThrow('blocked')
    expect(refunds[0]).toMatchObject({
      credit: { status: 'failed', error: expect.any(ChannelStore.IdempotencyKeyConflictError) },
      externalRefundAmount: null,
    })
  })

  test('reports a lost channel as a definite failure for merchant reconciliation', async () => {
    const store = memoryStore()
    await seedChannel(store, 10n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 1n, units: 1 }))
    const refunds: PrepaidRefund[] = []
    await expect(
      readStream(
        serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          prepaidUnits: 1,
          autoCreditPrepaid: true,
          generate: (async function* () {
            await store.updateChannel(channelId, () => null)
            yield await Promise.reject(new Error('delivery failed'))
          })(),
          onRefundRequired(refund) {
            refunds.push(refund)
          },
        }),
      ),
    ).rejects.toThrow('delivery failed')
    expect(refunds[0]).toMatchObject({ credit: { status: 'failed' }, externalRefundAmount: null })
  })

  test.each(['cancel', 'abort'] as const)(
    'clears pending obligations on %s without crediting cancellation',
    async (mode) => {
      const store = memoryStore()
      await seedChannel(store, 1000n)
      await store.updateChannel(channelId, (current) => ({ ...current!, spent: 1n, units: 1 }))
      for (let i = 0; i <= maxPrepaidRefunds; i++) {
        const controller = new AbortController()
        const stream = serve({
          store,
          channelId,
          challengeId,
          tickCost: 1n,
          prepaidUnits: 1,
          autoCreditPrepaid: true,
          signal: controller.signal,
          generate: generate(['not delivered']),
        })
        if (mode === 'abort') controller.abort()
        await stream.cancel()
      }
      expect(await store.getChannel(channelId)).toMatchObject({
        spent: 1n,
        units: 1,
        prepaidRefunds: {},
      })
    },
  )

  test('bounds refund records without evicting unexpired retry outcomes', async () => {
    const store = memoryStore()
    await seedChannel(store, 1000n)
    await store.updateChannel(channelId, (current) => ({ ...current!, spent: 500n, units: 500 }))
    for (let i = 0; i < maxPrepaidRefunds; i++)
      await ChannelStore.creditChannel(store, channelId, 1n, {
        idempotencyKey: String(i),
        maxMarkers: maxPrepaidRefunds,
      })
    await expect(
      preparePrepaidRefund({
        store,
        channelId,
        challengeId,
        tickCost: 1n,
        prepaidUnits: 1,
        autoCreditPrepaid: true,
        refundIdempotencyKey: 'new',
        generate: generate([]),
      }),
    ).rejects.toThrow('capacity reached')
    await expect(
      ChannelStore.creditChannel(store, channelId, 1n, {
        idempotencyKey: 'new',
        maxMarkers: maxPrepaidRefunds,
      }),
    ).rejects.toThrow('capacity reached')
    expect(
      await ChannelStore.creditChannel(store, channelId, 1n, {
        idempotencyKey: '0',
        maxMarkers: maxPrepaidRefunds,
      }),
    ).toMatchObject({ status: 'credited', replayed: true })
    expect(Object.keys((await store.getChannel(channelId))!.idempotencyMarkers!)).toHaveLength(
      maxPrepaidRefunds,
    )
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
      autoCreditPrepaid: true,
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
      autoCreditPrepaid: true,
      prepaidUnits: 1,
    })

    await readStream(stream)

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(4015n)
    expect(channel!.units).toBe(2)
  })

  test('runs the post-commit hook before emitting each charged value', async () => {
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

  test('does not emit a charged value when the post-commit hook fails', async () => {
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

    await expect(reader.read()).rejects.toThrow('settlement failed')
    const channel = await storage.getChannel(channelId)
    expect(channel).toMatchObject({ spent: 1000000n, units: 1 })
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

  test('retains a manual charge when the reader cancels', async () => {
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
    expect(channel).toMatchObject({ spent: 1000000n, units: 1 })
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

  test('aborting an idle backpressured stream releases its generator', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 10000000n)
    const controller = new AbortController()
    const cleanup = vi.fn()

    async function* idleGen(): AsyncGenerator<string> {
      try {
        yield 'queued'
      } finally {
        cleanup()
      }
    }

    serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: idleGen(),
      signal: controller.signal,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
  })

  test('closes immediately when created with an aborted signal', async () => {
    const storage = memoryStore()
    const controller = new AbortController()
    controller.abort()

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: generate(['unreachable']),
      signal: controller.signal,
    })

    await expect(stream.getReader().read()).resolves.toEqual({ done: true, value: undefined })
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

  test('rejects manual charges after channel close is requested', async () => {
    const storage = memoryStore()
    await seedChannel(storage, 1000000n)

    const stream = serve({
      store: storage,
      channelId,
      challengeId,
      tickCost: 1000000n,
      generate: async function* (stream) {
        await storage.updateChannel(channelId, (current) =>
          current ? { ...current, closeRequestedAt: 1n } : null,
        )
        await stream.charge()
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
