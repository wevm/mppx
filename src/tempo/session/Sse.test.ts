import type { Address, Hex } from 'viem'
import { describe, expect, test } from 'vitest'

import { chainId, escrowContract as escrowContractDefaults } from '../internal/defaults.js'
import type * as ChannelStore from './ChannelStore.js'
import { formatNeedVoucherEvent, formatReceiptEvent, parseEvent, serve } from './Sse.js'
import type { NeedVoucherEvent, SessionReceipt } from './Types.js'

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const challengeId = 'challenge-1'

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
})
