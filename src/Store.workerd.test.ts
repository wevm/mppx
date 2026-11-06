import * as path from 'node:path'

import { Miniflare } from 'miniflare'
import { rolldown } from 'rolldown'
import { afterAll, beforeAll, describe, expect, test } from 'vp/test'

// Runs Store.durableObject() and Store.d1() in workerd, the Cloudflare Workers
// runtime, through Miniflare: real Durable Objects with their input gates, a
// real D1 database, and concurrent requests, instead of in-process fakes.

let miniflare: Miniflare

beforeAll(async () => {
  const bundle = await rolldown({
    input: path.join(import.meta.dirname, '../test/workerd/store.worker.ts'),
    external: ['cloudflare:workers'],
    platform: 'neutral',
  })
  const { output } = await bundle.generate({ format: 'esm' })
  miniflare = new Miniflare({
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    durableObjects: {
      NATIVE_STORE: 'NativeStore',
      RECORDING: 'RecordingStore',
      RPC_STORE: 'RpcStore',
      STORE: 'MppxStore',
    },
    modules: [{ type: 'ESModule', path: 'worker.js', contents: output[0].code }],
  })
  await miniflare.ready
})

afterAll(async () => {
  await miniflare?.dispose()
})

async function request<result>(command: Record<string, unknown>): Promise<result> {
  const response = await miniflare.dispatchFetch('http://store/', {
    body: JSON.stringify(command),
    method: 'POST',
  })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return (await response.json()) as result
}

describe.each([
  { backend: 'durableObject' },
  { backend: 'rpc' },
  { backend: 'native' },
  { backend: 'd1' },
])('Store.$backend in workerd', ({ backend }) => {
  const run = <result>(command: Record<string, unknown>) => request<result>({ ...command, backend })

  test('round-trips, overwrites and deletes values', async () => {
    const value = { name: 'alice', scores: [1, 2, 3], meta: { active: true } }
    expect(await run({ op: 'get', key: 'roundtrip' })).toBeNull()
    await run({ op: 'put', key: 'roundtrip', value })
    expect(await run({ op: 'get', key: 'roundtrip' })).toEqual(value)
    await run({ op: 'put', key: 'roundtrip', value: 'second' })
    expect(await run({ op: 'get', key: 'roundtrip' })).toBe('second')
    await run({ op: 'delete', key: 'roundtrip' })
    expect(await run({ op: 'get', key: 'roundtrip' })).toBeNull()
  })

  test('preserves bigints', async () => {
    expect(
      await run({ op: 'bigint', key: 'bigint', amount: '123456789012345678901234567890' }),
    ).toEqual({ type: 'bigint', amount: '123456789012345678901234567890' })
  })

  test('keeps update atomic across concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => run<number>({ op: 'increment', key: 'counter' })),
    )
    expect(results.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await run({ op: 'get', key: 'counter' })).toBe(50)
  })

  test('records a replay claim exactly once across concurrent requests', async () => {
    const expires = Date.now() + 60_000
    const results = await Promise.all(
      Array.from({ length: 20 }, () => run<boolean>({ op: 'claim', key: 'nonce', expires })),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await run({ op: 'claim', key: 'expired', expires: Date.now() - 1 })).toBe(false)
  })

  test('separates keys by prefix', async () => {
    await run({ op: 'put', key: 'k', value: 1, prefix: 'tenant:' })
    expect(await run({ op: 'get', key: 'tenant:k' })).toBe(1)
    expect(await run({ op: 'get', key: 'k' })).toBeNull()
  })
})

describe('Store.durableObject native encoding in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'native' })

  test('reads and updates values a plain Durable Object wrote with bigints', async () => {
    expect(await run({ op: 'legacy', key: 'channel', amount: '41' })).toEqual({
      read: { deposit: '100000000000000000000', nonce: 'bigint' },
      // Still a bigint in storage, not JSON text.
      raw: { spent: '42' },
      spent: '42',
    })
  })

  test('compares nested values with bigints structurally across concurrent updates', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        run<string>({ op: 'increment-bigint', key: 'native-counter' }),
      ),
    )
    expect(results.map(Number).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    )
  })
})

describe('Store.DurableObjectStore hooks in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'recording' })
  type Log = { alarms: number; writes: { key: string; previous: unknown; next: unknown }[] }

  test('onWrite sees every applied write, and alarm fires', async () => {
    const key = 'hooked'
    await run({ op: 'put', key, value: { a: 1 } })
    await run({ op: 'put', key, value: { a: 2 } })
    expect(await run({ op: 'increment', key: 'hooked-counter' })).toBe(1)
    // A swap that conflicts writes nothing.
    expect(
      await run({ op: 'raw', key, body: { op: 'swap', key, expected: '"stale"', value: '1' } }),
    ).toEqual({ applied: false, current: '{"a":2}' })
    expect(
      await run({ op: 'raw', key, body: { op: 'swap', key, expected: '{"a":2}', value: '3' } }),
    ).toEqual({ applied: true })
    await run({ op: 'delete', key })
    const expires = Date.now() + 60_000
    expect(await run({ op: 'claim', key, expires })).toBe(true)
    // A claim that loses writes nothing.
    expect(await run({ op: 'claim', key, expires })).toBe(false)

    const log = await run<Log>({ op: 'log', key })
    expect(log.writes).toEqual([
      { key, previous: null, next: { a: 1 } },
      { key, previous: { a: 1 }, next: { a: 2 } },
      { key, previous: { a: 2 }, next: 3 },
      { key, previous: 3, next: null },
      { key, previous: null, next: { expires, type: 'mppx:replay' } },
    ])
    expect((await run<Log>({ op: 'log', key: 'hooked-counter' })).writes).toEqual([
      { key: 'hooked-counter', previous: null, next: 1 },
    ])

    await expect
      .poll(async () => (await run<Log>({ op: 'log', key })).alarms, { timeout: 5_000 })
      .toBeGreaterThan(0)
  })
})
