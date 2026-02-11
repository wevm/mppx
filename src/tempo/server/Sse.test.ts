import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import { serve, toResponse } from '../stream/Sse.js'
import type { ChannelState, ChannelStorage } from '../stream/Storage.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'test-challenge-id'
const tickCost = 1000000n

function memoryStorage(): ChannelStorage {
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

function seedChannel(storage: ChannelStorage, balance: bigint): Promise<ChannelState | null> {
  return storage.updateChannel(channelId, () => ({
    channelId,
    payer: '0x0000000000000000000000000000000000000001' as Address,
    payee: '0x0000000000000000000000000000000000000002' as Address,
    token: '0x0000000000000000000000000000000000000003' as Address,
    authorizedSigner: '0x0000000000000000000000000000000000000004' as Address,
    deposit: balance,
    settledOnChain: 0n,
    highestVoucherAmount: balance,
    highestVoucher: null,
    spent: 0n,
    units: 0,
    finalized: false,
    createdAt: new Date(),
  }))
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

describe('Sse.serve', () => {
  test('emits message events for each yielded value (StreamController)', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 3000000n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        generate: async function* (stream) {
          await stream.charge()
          yield 'hello'
          await stream.charge()
          yield 'world'
          await stream.charge()
          yield 'done'
        },
      }),
    )

    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')

    const output = await readStream(response.body!)

    expect(output).toContain('event: message\ndata: hello\n\n')
    expect(output).toContain('event: message\ndata: world\n\n')
    expect(output).toContain('event: message\ndata: done\n\n')
    expect(output).toContain('event: payment-receipt\n')

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(3000000n)
    expect(channel!.units).toBe(3)
  })

  test('emits payment-need-voucher when balance exhausted and resumes after top-up', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 1000000n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        pollIntervalMs: 10,
        generate: async function* (stream) {
          await stream.charge()
          yield 'first'
          await stream.charge()
          yield 'second'
        },
      }),
    )

    const reader = response.body!.getReader()
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

  test('respects abort signal', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 10000000n)

    const controller = new AbortController()

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        signal: controller.signal,
        generate: async function* (stream) {
          let i = 0
          while (true) {
            await stream.charge()
            yield `chunk-${i++}`
            await new Promise((r) => setTimeout(r, 5))
          }
        },
      }),
    )

    const reader = response.body!.getReader()
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
    const storage = memoryStorage()
    await seedChannel(storage, 2000000n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        generate: async function* (stream) {
          await stream.charge()
          yield 'a'
          await stream.charge()
          yield 'b'
        },
      }),
    )

    const output = await readStream(response.body!)
    const receiptRaw = output.split('event: payment-receipt\ndata: ')[1]?.split('\n\n')[0]
    const receipt = JSON.parse(receiptRaw!)

    expect(receipt.challengeId).toBe('test-challenge-id')
    expect(receipt.channelId).toBe(channelId)
    expect(receipt.spent).toBe('2000000')
    expect(receipt.units).toBe(2)
  })

  test('handles empty generator', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 1000000n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        generate: async function* () {},
      }),
    )

    const output = await readStream(response.body!)
    expect(output).toContain('event: payment-receipt\n')
    expect(output).not.toContain('event: message\n')

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(0n)
    expect(channel!.units).toBe(0)
  })

  test('allows tickCost override', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 500n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost: 100n,
        generate: async function* (stream) {
          for (let i = 0; i < 5; i++) {
            await stream.charge()
            yield `tok-${i}`
          }
        },
      }),
    )

    const output = await readStream(response.body!)
    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`event: message\ndata: tok-${i}\n\n`)
    }

    const channel = await storage.getChannel(channelId)
    expect(channel!.spent).toBe(500n)
    expect(channel!.units).toBe(5)
  })

  test('sets correct SSE response headers', async () => {
    const storage = memoryStorage()
    await seedChannel(storage, 1000000n)

    const response = toResponse(
      serve({
        storage,
        channelId,
        challengeId,
        tickCost,
        generate: async function* () {},
      }),
    )

    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(response.headers.get('Connection')).toBe('keep-alive')
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
  })
})
