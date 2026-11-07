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
    // SQLite-backed, as production binds them: replay shards need SQL.
    durableObjects: {
      FAILING: { className: 'FailingStore', useSQLite: true },
      // Key-value-backed, as classes bound with `new_classes` are.
      KV_RECORDING: { className: 'KvRecordingStore', useSQLite: false },
      NATIVE_STORE: { className: 'NativeStore', useSQLite: true },
      RECORDING: { className: 'RecordingStore', useSQLite: true },
      RECORDING_RPC: { className: 'RecordingRpcStore', useSQLite: true },
      RPC_STORE: { className: 'RpcStore', useSQLite: true },
      STORE: { className: 'MppxStore', useSQLite: true },
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
  { backend: 'durableObject', label: 'durableObject' },
  { backend: 'rpc', label: 'durableObject (rpc)' },
  { backend: 'native', label: 'durableObject (rpc, native)' },
  { backend: 'd1', label: 'd1' },
])('Store.$label in workerd', ({ backend }) => {
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

  test('updates values holding typed arrays, buffers, maps, sets, dates, regexps and holes', async () => {
    expect(await run({ op: 'rich', key: 'rich' })).toEqual({ n: 2, bytes: [1, 2], hole: false })
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

describe.each([
  { backend: 'durableObject', label: 'fetch' },
  { backend: 'rpc', label: 'rpc' },
])('Store.durableObject replay shards over $label in workerd', ({ backend }) => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend, options: { replayShards: 4 } })

  test('records a claim exactly once across concurrent requests', async () => {
    const expires = Date.now() + 60_000
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        run<boolean>({ op: 'claim', key: `${backend}:nonce`, expires }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await run({ op: 'claim', key: `${backend}:expired`, expires: Date.now() - 1 })).toBe(
      false,
    )
  })

  test('claims a key again once its claim expires', async () => {
    const key = `${backend}:expiring`
    expect(await run({ op: 'claim', key, expires: Date.now() + 300 })).toBe(true)
    expect(await run({ op: 'claim', key, expires: Date.now() + 60_000 })).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await run({ op: 'claim', key, expires: Date.now() + 60_000 })).toBe(true)
  })

  test('claims a key again once delete releases it', async () => {
    const key = `${backend}:released`
    expect(await run({ op: 'claim', key, expires: Date.now() + 60_000 })).toBe(true)
    await run({ op: 'delete', key })
    expect(await run({ op: 'claim', key, expires: Date.now() + 60_000 })).toBe(true)
    expect(await run({ op: 'claim', key, expires: Date.now() + 60_000 })).toBe(false)
  })
})

describe('Store.durableObject replay shards in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'rpc', options: { replayShards: 4 } })

  test('spreads claims across the shards, outside the per-key objects', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `spread:${i}`)
    const expires = Date.now() + 60_000
    expect(await Promise.all(keys.map((key) => run({ op: 'claim', key, expires })))).toEqual(
      keys.map(() => true),
    )
    const shards = await run<string[][]>({ op: 'shards', shards: 4, version: 1 })
    const spread = shards.map((claims) => claims.filter((key) => key.startsWith('spread:')))
    for (const claims of spread) expect(claims.length).toBeGreaterThan(0)
    expect(spread.flat().toSorted()).toEqual(keys.toSorted())
    expect(await run({ op: 'get', key: 'spread:0' })).toBeNull()
  })

  test('clears expired claims with an alarm', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `alarm:${i}`)
    for (const key of keys) await run({ op: 'claim', key, expires: Date.now() + 200 })
    const remaining = async () =>
      (await run<string[][]>({ op: 'shards', shards: 4, version: 1 }))
        .flat()
        .filter((key) => key.startsWith('alarm:')).length
    expect(await remaining()).toBe(8)
    await expect.poll(remaining, { timeout: 5_000, interval: 100 }).toBe(0)
  })

  test('starts from empty shards for a new replayShardVersion', async () => {
    const expires = Date.now() + 60_000
    expect(await run({ op: 'claim', key: 'versioned', expires })).toBe(true)
    expect(
      await request({
        backend: 'rpc',
        op: 'claim',
        key: 'versioned',
        expires,
        options: { replayShards: 4, replayShardVersion: 2 },
      }),
    ).toBe(true)
    expect((await run<string[][]>({ op: 'shards', shards: 4, version: 2 })).flat()).toEqual([
      'versioned',
    ])
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

describe('Store.DurableObjectStore on key-value storage in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'kv-recording' })

  test("runs a subclass's alarm that calls super.alarm()", async () => {
    const key = 'kv-hooked'
    await run({ op: 'put', key, value: { a: 1 } })
    await expect
      .poll(async () => (await run<{ alarms: number }>({ op: 'log', key })).alarms, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0)
  })
})

describe('Store.DurableObjectStore.rpc on a subclass in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'recording-rpc' })
  type Log = { alarms: number; writes: { key: string; previous: unknown; next: unknown }[] }

  test("keeps the subclass's onWrite and alarm", async () => {
    const key = 'rpc-hooked'
    await run({ op: 'put', key, value: { a: 1 } })
    await run({ op: 'delete', key })
    const expires = Date.now() + 60_000
    expect(await run({ op: 'claim', key, expires })).toBe(true)
    expect((await run<Log>({ op: 'log', key })).writes).toEqual([
      { key, previous: null, next: { a: 1 } },
      { key, previous: { a: 1 }, next: null },
      { key, previous: null, next: { expires, type: 'mppx:replay' } },
    ])
    await expect
      .poll(async () => (await run<Log>({ op: 'log', key })).alarms, { timeout: 5_000 })
      .toBeGreaterThan(0)
  })
})

describe('Store.DurableObjectStore write hook failures in workerd', () => {
  const run = <result>(command: Record<string, unknown>) =>
    request<result>({ ...command, backend: 'failing' })

  test('rolls back a write and the hook writes when onWrite throws', async () => {
    const key = 'atomic'
    await run({ op: 'put', key, value: { v: 1 } })
    expect(await run({ op: 'hooked', key })).toBe(1)
    await run({ op: 'arm', key })
    await expect(run({ op: 'put', key, value: { v: 2 } })).rejects.toThrow()
    expect(await run({ op: 'get', key })).toEqual({ v: 1 })
    expect(await run({ op: 'hooked', key })).toBe(1)
    await run({ op: 'arm', key })
    await expect(run({ op: 'delete', key })).rejects.toThrow()
    expect(await run({ op: 'get', key })).toEqual({ v: 1 })
    expect(await run({ op: 'hooked', key })).toBe(1)
  })

  test('leaves a key claimable after a claim whose onWrite throws', async () => {
    const key = 'atomic-claim'
    const expires = Date.now() + 60_000
    await run({ op: 'arm', key })
    await expect(run({ op: 'claim', key, expires })).rejects.toThrow()
    expect(await run({ op: 'claim', key, expires })).toBe(true)
    expect(await run({ op: 'claim', key, expires })).toBe(false)
  })
})
