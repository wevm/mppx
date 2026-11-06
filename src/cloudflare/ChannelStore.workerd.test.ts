import * as path from 'node:path'

import { Miniflare } from 'miniflare'
import { rolldown } from 'rolldown'
import { afterAll, beforeAll, describe, expect, test } from 'vp/test'

// Runs the Cloudflare channel store in workerd through Miniflare: real Durable Objects,
// alarms and a queue whose consumer settles with a stub instead of a transaction.

let miniflare: Miniflare

beforeAll(async () => {
  const bundle = await rolldown({
    input: path.join(import.meta.dirname, '../../test/workerd/channels.worker.ts'),
    external: ['cloudflare:workers'],
    // viem's optional Node imports go unused in workerd.
    logLevel: 'silent',
    platform: 'neutral',
  })
  // One module: workerd loads only the bundle, and viem's chunks would be separate files.
  const { output } = await bundle.generate({ format: 'esm', inlineDynamicImports: true })
  miniflare = new Miniflare({
    compatibilityDate: '2026-07-01',
    durableObjects: {
      CHANNELS: { className: 'Channels', useSQLite: true },
      LOG: { className: 'Log', useSQLite: true },
    },
    modules: [{ type: 'ESModule', path: 'worker.js', contents: output[0].code }],
    queueConsumers: { settlements: { maxBatchTimeout: 0, maxRetries: 0 } },
    queueProducers: { QUEUE: { queueName: 'settlements' } },
  })
  await miniflare.ready
})

afterAll(async () => {
  await miniflare?.dispose()
})

async function run<result>(command: Record<string, unknown>): Promise<result> {
  const response = await miniflare.dispatchFetch('http://channels/', {
    body: JSON.stringify(command),
    method: 'POST',
  })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return (await response.json()) as result
}

let next = 0
/** A fresh channel ID and payer per test. */
function channel() {
  next++
  return {
    id: `0x${next.toString(16).padStart(64, '0')}`,
    payer: `0x${next.toString(16).padStart(40, 'a')}`,
  }
}

const calls = (id: string) => () => run<number>({ op: 'calls', id })

describe('cloudflare.ChannelStore in workerd', () => {
  test('sends a channel over the threshold to the queue at once and settles it', async () => {
    const { id, payer } = channel()
    await run({ op: 'mode', id, mode: 'settle' })
    // 10% of the deposit is 1_000; the voucher captures 2_000.
    await run({ op: 'write', id, payer, deposit: '10000', voucher: '2000' })
    await expect.poll(calls(id), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => run({ op: 'settled', id }), { timeout: 5_000 }).toBe('2000')
    // Settling cleared the bookkeeping, so the watchdog sends nothing more.
    await expect
      .poll(() => run({ op: 'status', id }), { timeout: 5_000 })
      .toMatchObject({ sends: null })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await calls(id)()).toBe(1)
  })

  test('settles a channel below the threshold once it goes stale', async () => {
    const { id, payer } = channel()
    await run({ op: 'mode', id, mode: 'settle' })
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '500' })
    expect(await run({ op: 'status', id })).toEqual({ alarm: true, sends: 0 })
    expect(await calls(id)()).toBe(0)
    await expect.poll(calls(id), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => run({ op: 'settled', id }), { timeout: 5_000 }).toBe('500')
  })

  test('sends an unsettled channel again from the watchdog, up to maxAttempts', async () => {
    const { id, payer } = channel()
    // The job runs but never settles, as a dropped transaction would.
    await run({ op: 'mode', id, mode: 'drop' })
    await run({ op: 'write', id, payer, deposit: '10000', voucher: '2000' })
    await expect.poll(calls(id), { timeout: 10_000 }).toBe(3)
    await expect
      .poll(() => run({ op: 'status', id }), { timeout: 10_000 })
      .toMatchObject({ sends: null })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(await calls(id)()).toBe(3)
  })

  test('acknowledges a channel that cannot settle', async () => {
    const { id, payer } = channel()
    await run({ op: 'mode', id, mode: 'reject' })
    await run({ op: 'write', id, payer, deposit: '10000', voucher: '2000' })
    await expect.poll(calls(id), { timeout: 5_000 }).toBe(1)
    expect(await run({ op: 'settled', id })).toBe('0')
  })

  test('schedules nothing for a finalized or settled channel', async () => {
    const finalized = channel()
    await run({ op: 'write', ...finalized, deposit: '10000', voucher: '2000', finalized: true })
    expect(await run({ op: 'status', id: finalized.id })).toEqual({ alarm: false, sends: null })
    const settled = channel()
    await run({ op: 'write', ...settled, deposit: '10000', voucher: '2000', settled: '2000' })
    expect(await run({ op: 'status', id: settled.id })).toEqual({ alarm: false, sends: null })
  })

  test('schedules settlement of channels written as JSON over fetch', async () => {
    const { id, payer } = channel()
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '500', transport: 'fetch' })
    expect(await run({ op: 'status', id })).toEqual({ alarm: true, sends: 0 })
  })

  test("repairs a missing lookup entry on the channel's next write", async () => {
    const { id, payer } = channel()
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '1', unindexed: true })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBeNull()
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '2' })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBe(id)
  })

  test('indexes an open channel for its payer and drops it once closing or finalized', async () => {
    const { id, payer } = channel()
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBeNull()
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '1' })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBe(id)
    expect(await run({ op: 'resolve', payer, chainId: 4217 })).toBeNull()
    await run({ op: 'write', id, payer, deposit: '1000000', voucher: '1', closeRequested: true })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBeNull()

    const reopened = channel()
    await run({ op: 'write', id: reopened.id, payer, deposit: '1000000', voucher: '1' })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBe(reopened.id)
    await run({
      op: 'write',
      id: reopened.id,
      payer,
      deposit: '1000000',
      voucher: '1',
      finalized: true,
    })
    expect(await run({ op: 'resolve', payer, chainId: 42431 })).toBeNull()
  })
})
