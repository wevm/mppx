import { describe, expect, test } from 'vitest'
import * as Store from './Store.js'

const nested = {
  name: 'alice',
  scores: [1, 2, 3],
  meta: { active: true, tags: ['a', 'b'] },
}

function fakeKv(): Store.cloudflare.Parameters {
  const map = new Map<string, string>()
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

describe.each([
  { label: 'memory', create: () => Store.memory() },
  { label: 'cloudflare', create: () => Store.cloudflare(fakeKv()) },
  {
    label: 'upstash',
    create: () => {
      const kv = fakeKv()
      return Store.upstash({
        get: kv.get,
        set: (key, value) => kv.put(key, value as string),
        del: (key) => kv.delete(key),
      })
    },
  },
])('$label', ({ create }) => {
  test('roundtrip', async () => {
    const store = create()
    await store.put('k', nested)
    expect(await store.get('k')).toEqual(nested)
  })

  test('get missing key returns null', async () => {
    const store = create()
    expect(await store.get('missing')).toBeNull()
  })

  test('delete removes key', async () => {
    const store = create()
    await store.put('k', 'value')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })

  test('put overwrites existing value', async () => {
    const store = create()
    await store.put('k', 'first')
    await store.put('k', 'second')
    expect(await store.get('k')).toBe('second')
  })
})

describe('json roundtrip behavior', () => {
  test('memory json-roundtrips nested objects', async () => {
    const store = Store.memory()
    const value = { a: [1, { b: 'c' }], d: null }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('cloudflare json-roundtrips nested objects', async () => {
    const store = Store.cloudflare(fakeKv())
    const value = { a: [1, { b: 'c' }], d: null }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('upstash passes values through without json serialization', async () => {
    const kv = fakeKv()
    const store = Store.upstash({
      get: kv.get,
      set: (key, value) => kv.put(key, value as string),
      del: (key) => kv.delete(key),
    })
    const value = { a: 1 }
    await store.put('k', value)
    // upstash store does not JSON-serialize; the fake map holds the original reference
    expect(await kv.get('k')).toBe(value)
  })
})
