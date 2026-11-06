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
    platform: 'neutral',
  })
  const { output } = await bundle.generate({ format: 'esm' })
  miniflare = new Miniflare({
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    durableObjects: { STORE: 'MppxStore' },
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

describe.each([{ backend: 'durableObject' }, { backend: 'd1' }])(
  'Store.$backend in workerd',
  ({ backend }) => {
    const run = <result>(command: Record<string, unknown>) =>
      request<result>({ ...command, backend })

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
  },
)
