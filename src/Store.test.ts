import { describe, expect, test } from 'vp/test'

import * as Store from './Store.js'

const nested = {
  name: 'alice',
  scores: [1, 2, 3],
  meta: { active: true, tags: ['a', 'b'] },
}

function applyChange<value, result>(
  map: Map<string, value>,
  key: string,
  change: Store.Change<value, result>,
) {
  if (change.op === 'set') map.set(key, change.value)
  if (change.op === 'delete') map.delete(key)
  return change.result
}

function fakeStringKv() {
  const map = new Map<string, string>()
  return {
    async get(key: string) {
      return map.get(key) ?? null
    },
    async put(key: string, value: string) {
      map.set(key, value)
    },
    async delete(key: string) {
      map.delete(key)
    },
    async update<result>(
      key: string,
      fn: (current: string | null) => Store.Change<string, result>,
    ) {
      return applyChange(map, key, fn(map.get(key) ?? null))
    },
  }
}

function fakeUnknownKv() {
  const map = new Map<string, unknown>()
  return {
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: unknown) {
      map.set(key, value)
    },
    async del(key: string) {
      map.delete(key)
    },
    async update<result>(
      key: string,
      fn: (current: unknown | null) => Store.Change<unknown, result>,
    ) {
      return applyChange(map, key, fn(map.get(key) ?? null))
    },
  }
}

function fakeTryClaim(seen?: string[]) {
  const claimed = new Set<string>()
  return async (key: string, _expires: number) => {
    seen?.push(key)
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  }
}

describe.each([
  { label: 'memory', create: () => Store.memory() },
  { label: 'cloudflare', create: () => Store.cloudflare(fakeStringKv()) },
  {
    label: 'redis',
    create: () => {
      const kv = fakeStringKv()
      return Store.redis({
        get: kv.get,
        set: kv.put,
        del: (key) => kv.delete(key),
      })
    },
  },
  {
    label: 'upstash',
    create: () => {
      const kv = fakeUnknownKv()
      return Store.upstash({
        get: kv.get,
        set: kv.set,
        del: kv.del,
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

describe('keyPrefix', () => {
  test('scopes get, put, and delete to prefixed backing keys', async () => {
    const backing = Store.memory()
    const store = Store.from(backing, { keyPrefix: 'tenant:' })

    await store.put('k', nested)
    expect(await backing.get('tenant:k')).toEqual(nested)
    expect(await backing.get('k')).toBeNull()
    expect(await store.get('k')).toEqual(nested)

    await store.delete('k')
    expect(await backing.get('tenant:k')).toBeNull()
  })

  test('scopes atomic update to prefixed backing keys', async () => {
    const backing = Store.memory()
    const store = Store.from(backing, { keyPrefix: 'tenant:' })

    const result = await store.update('k', (current) => {
      expect(current).toBeNull()
      return { op: 'set', value: { count: 1 }, result: 'created' as const }
    })

    expect(result).toBe('created')
    expect(await backing.get('tenant:k')).toEqual({ count: 1 })
    expect(await backing.get('k')).toBeNull()
  })

  test('scopes optimized tryClaim to prefixed backing keys', async () => {
    const backing = Store.memory()
    const store = Store.from(backing, { keyPrefix: 'tenant:' })
    const expires = Date.now() + 60_000

    expect(await Store.tryClaim(store, 'k', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(false)
    expect(await backing.get('tenant:k')).toEqual({ expires, type: 'mppx:replay' })
    expect(await backing.get('k')).toBeNull()
  })

  test('returns the original store when keyPrefix is empty', () => {
    const backing = Store.memory()
    expect(Store.from(backing, { keyPrefix: '' })).toBe(backing)
  })

  test('reuses wrappers for the same backing store and prefix', () => {
    const backing = Store.memory()
    expect(Store.from(backing, { keyPrefix: 'tenant:' })).toBe(
      Store.from(backing, { keyPrefix: 'tenant:' }),
    )
    expect(Store.from(backing, { keyPrefix: 'other:' })).not.toBe(
      Store.from(backing, { keyPrefix: 'tenant:' }),
    )
  })

  test('constructs memory stores with a keyPrefix', async () => {
    const store = Store.memory({ keyPrefix: 'tenant:' })
    await store.put('k', 'value')
    expect(await store.get('k')).toBe('value')
  })

  test('constructs adapter stores with a keyPrefix', async () => {
    const cloudflareKv = fakeStringKv()
    const cloudflare = Store.cloudflare(cloudflareKv, { keyPrefix: 'tenant:' })
    await cloudflare.put('k', 'value')
    expect(await cloudflareKv.get('tenant:k')).not.toBeNull()
    expect(await cloudflareKv.get('k')).toBeNull()

    const redisKv = fakeStringKv()
    const redis = Store.redis(
      {
        get: redisKv.get,
        set: redisKv.put,
        del: redisKv.delete,
      },
      { keyPrefix: 'tenant:' },
    )
    await redis.put('k', 'value')
    expect(await redisKv.get('tenant:k')).not.toBeNull()
    expect(await redisKv.get('k')).toBeNull()

    const upstashKv = fakeUnknownKv()
    const upstash = Store.upstash(upstashKv, { keyPrefix: 'tenant:' })
    await upstash.put('k', 'value')
    expect(await upstashKv.get('tenant:k')).toBe('value')
    expect(await upstashKv.get('k')).toBeNull()
  })
})

describe('tryClaim', () => {
  test('uses an adapter fast path when available', async () => {
    const backing = Store.memory()
    const optimized = backing.tryClaim!
    let calls = 0
    const store = {
      ...backing,
      tryClaim(key: string, expires: number) {
        calls++
        return optimized(key, expires)
      },
    }
    const expires = Date.now() + 60_000

    expect(await Store.tryClaim(store, 'k', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(false)
    expect(await store.get('k')).toEqual({ expires, type: 'mppx:replay' })
    expect(calls).toBe(2)
  })

  test('falls back to atomic update and replaces expired claims', async () => {
    const store = Store.cloudflare(fakeStringKv())
    expect(store.tryClaim).toBeUndefined()
    const expires = Date.now() + 60_000

    expect(await Store.tryClaim(store, 'k', Date.now() - 1)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(false)
    expect(await store.get('k')).toEqual({ expires, type: 'mppx:replay' })
  })

  test('preserves legacy replay markers as consumed', async () => {
    const store = Store.memory()
    await store.put('k', Date.now() - 60_000)

    expect(await Store.tryClaim(store, 'k', Date.now() + 60_000)).toBe(false)
  })

  test('composes a Redis-native claim with the adapter', async () => {
    const kv = fakeStringKv()
    let updateCalls = 0
    const store = Store.from({
      ...Store.redis({
        get: kv.get,
        set: kv.put,
        del: kv.delete,
        update: (key, fn) => {
          updateCalls++
          return kv.update(key, fn)
        },
      }),
      tryClaim: fakeTryClaim(),
    })
    const expires = Date.now() + 60_000

    expect(await Store.tryClaim(store, 'k', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(false)
    expect(updateCalls).toBe(0)
  })

  test('composes an Upstash-native claim with the adapter', async () => {
    const store = Store.from({
      ...Store.upstash(fakeUnknownKv()),
      tryClaim: fakeTryClaim(),
    })
    const expires = Date.now() + 60_000

    expect(await Store.tryClaim(store, 'k', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'k', expires)).toBe(false)
  })

  test('prefixes a composed native claim', async () => {
    const kv = fakeStringKv()
    const seen: string[] = []
    const store = Store.from(
      {
        ...Store.redis({
          get: kv.get,
          set: kv.put,
          del: kv.delete,
          update: kv.update,
        }),
        tryClaim: fakeTryClaim(seen),
      },
      { keyPrefix: 'p:' },
    )

    expect(await Store.tryClaim(store, 'k', Date.now() + 60_000)).toBe(true)
    expect(seen).toEqual(['p:k'])
  })
})

describe('json roundtrip behavior', () => {
  test('cloudflare json-roundtrips nested objects', async () => {
    const store = Store.cloudflare(fakeStringKv())
    const value = { a: [1, { b: 'c' }], d: null }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('cloudflare roundtrips BigInt values', async () => {
    const store = Store.cloudflare(fakeStringKv())
    const value = { amount: 1000000000000000000n, nested: { big: 42n } }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('memory json-roundtrips nested objects', async () => {
    const store = Store.memory()
    const value = { a: [1, { b: 'c' }], d: null }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('memory roundtrips BigInt values', async () => {
    const store = Store.memory()
    const value = { amount: 1000000000000000000n, nested: { big: 42n } }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('redis json-roundtrips nested objects', async () => {
    const kv = fakeStringKv()
    const store = Store.redis({
      get: kv.get,
      set: kv.put,
      del: (key) => kv.delete(key),
    })
    const value = { a: [1, { b: 'c' }], d: null }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('redis roundtrips BigInt values', async () => {
    const kv = fakeStringKv()
    const store = Store.redis({
      get: kv.get,
      set: kv.put,
      del: (key) => kv.delete(key),
    })
    const value = { amount: 1000000000000000000n, nested: { big: 42n } }
    await store.put('k', value)
    expect(await store.get('k')).toEqual(value)
  })

  test('upstash passes values through without json serialization', async () => {
    const kv = fakeUnknownKv()
    const store = Store.upstash({
      get: kv.get,
      set: kv.set,
      del: kv.del,
    })
    const value = { a: 1 }
    await store.put('k', value)
    // upstash store does not JSON-serialize; the fake map holds the original reference
    expect(await kv.get('k')).toBe(value)
  })

  test('memory update can noop, set, and delete with typed results', async () => {
    const store = Store.memory()

    const inserted = await store.update('k', (current) => {
      expect(current).toBeNull()
      return { op: 'set', value: { count: 1 }, result: 'inserted' as const }
    })
    const preserved = await store.update('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return { op: 'noop', result: 'unchanged' as const }
    })
    const deleted = await store.update('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return { op: 'delete', result: 'removed' as const }
    })

    expect(inserted).toBe('inserted')
    expect(preserved).toBe('unchanged')
    expect(deleted).toBe('removed')
    expect(await store.get('k')).toBeNull()
  })

  test('cloudflare update adapts JSON values through the wrapper', async () => {
    const kv = fakeStringKv()
    const store = Store.cloudflare(kv)

    await store.put('k', { count: 1 })
    const result = await store.update('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return {
        op: 'set',
        value: { count: (current as { count: number }).count + 1 },
        result: 'updated' as const,
      }
    })

    expect(result).toBe('updated')
    expect(await store.get('k')).toEqual({ count: 2 })
  })

  test('redis update adapts JSON values through the wrapper', async () => {
    const kv = fakeStringKv()
    const store = Store.redis({
      get: kv.get,
      set: kv.put,
      del: (key) => kv.delete(key),
      update: kv.update,
    })

    await store.put('k', { count: 1 })
    const result = await store.update('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return {
        op: 'set',
        value: { count: (current as { count: number }).count + 1 },
        result: 'updated' as const,
      }
    })

    expect(result).toBe('updated')
    expect(await store.get('k')).toEqual({ count: 2 })
  })

  test('upstash update passes values through the wrapper', async () => {
    const kv = fakeUnknownKv()
    const store = Store.upstash({
      get: kv.get,
      set: kv.set,
      del: kv.del,
      update: kv.update,
    })

    await store.put('k', { count: 1 })
    const result = await store.update('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return {
        op: 'set',
        value: { count: (current as { count: number }).count + 1 },
        result: 'updated' as const,
      }
    })

    expect(result).toBe('updated')
    expect(await store.get('k')).toEqual({ count: 2 })
  })

  test('upstash update passes through unencoded values', async () => {
    const kv = fakeUnknownKv()
    const store = Store.upstash(kv)

    await store.put('k', { count: 1 })
    const result = await store.update!('k', (current) => {
      expect(current).toEqual({ count: 1 })
      return { op: 'set', value: { count: (current as { count: number }).count + 1 }, result: 2 }
    })

    expect(result).toBe(2)
    expect(await kv.get('k')).toEqual({ count: 2 })
  })
})
