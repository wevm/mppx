import { DatabaseSync } from 'node:sqlite'

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test, vi } from 'vp/test'

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

function fakeDurableObjectNamespace() {
  const objects = new Map<string, Store.DurableObjectStore>()
  const queues = new Map<string, Promise<unknown>>()
  return {
    idFromName: (name: string) => name,
    get(id: string) {
      let object = objects.get(id)
      if (!object) {
        const map = new Map<string, string>()
        object = new Store.DurableObjectStore({
          storage: {
            async get(key: string) {
              return map.get(key)
            },
            async put(key: string, value: string) {
              map.set(key, value)
            },
            async delete(key: string) {
              return map.delete(key)
            },
          },
        })
        objects.set(id, object)
      }
      const target = object
      // Serialize calls per object, as a Durable Object's input gate does.
      return {
        fetch(input: string, init: RequestInit) {
          const response = (queues.get(id) ?? Promise.resolve()).then(() =>
            target.fetch(new Request(input, init)),
          )
          queues.set(
            id,
            response.catch(() => {}),
          )
          return response
        },
      }
    },
  }
}

describe.each([
  { label: 'memory', create: () => Store.memory() },
  { label: 'cloudflare', create: () => Store.cloudflare(fakeStringKv()) },
  { label: 'durableObject', create: () => Store.durableObject(fakeDurableObjectNamespace()) },
  { label: 'postgres', create: () => pgliteStore() },
  { label: 'sqlite', create: () => Store.sqlite(new DatabaseSync(':memory:')) },
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

    await store.put('k', { expires: Date.now() - 1, type: 'mppx:replay' })
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

/** node:sqlite behind better-sqlite3's API: all() throws on statements that return no rows. */
function betterSqlite3Like() {
  const db = new DatabaseSync(':memory:')
  return {
    prepare(text: string) {
      const statement = db.prepare(text)
      const reader = statement.columns().length > 0
      return {
        reader,
        all(...params: never[]) {
          if (!reader) throw new TypeError('This statement does not return data. Use run() instead')
          return statement.all(...params)
        },
        run: (...params: never[]) => statement.run(...params),
      }
    },
  }
}

let pglite: PGlite | undefined
let tables = 0

/** A Postgres store on a fresh table of one shared in-process PGlite database. */
function pgliteStore(options?: Store.sql.Options) {
  pglite ??= new PGlite()
  return Store.postgres(pglite, { table: `mppx_store_${++tables}`, ...options })
}

describe.each([
  { label: 'memory', create: (options?: Store.Options) => Store.memory(options) },
  {
    label: 'durableObject',
    create: (options?: Store.Options) => Store.durableObject(fakeDurableObjectNamespace(), options),
  },
  { label: 'postgres (PGlite)', create: (options?: Store.Options) => pgliteStore(options) },
  {
    label: 'sqlite (node:sqlite)',
    create: (options?: Store.Options) => Store.sqlite(new DatabaseSync(':memory:'), options),
  },
  {
    label: 'sqlite (better-sqlite3 API)',
    create: (options?: Store.Options) => Store.sqlite(betterSqlite3Like(), options),
  },
])('atomic: $label', ({ create }) => {
  test('round-trips values with bigints', async () => {
    const store = create()
    await store.put('k', { amount: 123456789012345678901234567890n, nested })
    expect(await store.get('k')).toEqual({ amount: 123456789012345678901234567890n, nested })
  })

  test('update stays atomic under concurrent writers', async () => {
    const store = create()
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.update('counter', (current) => {
          const value = ((current as number | null) ?? 0) + 1
          return { op: 'set', value, result: value }
        }),
      ),
    )
    expect(results.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await store.get('counter')).toBe(50)
  })

  test('update supports noop and delete', async () => {
    const store = create()
    expect(await store.update('k', () => ({ op: 'noop', result: 'none' }))).toBe('none')
    expect(await store.get('k')).toBeNull()
    await store.put('k', 1)
    expect(await store.update('k', () => ({ op: 'noop', result: 'kept' }))).toBe('kept')
    expect(await store.get('k')).toBe(1)
    expect(await store.update('k', () => ({ op: 'delete', result: 'gone' }))).toBe('gone')
    expect(await store.get('k')).toBeNull()
    expect(await store.update('k', () => ({ op: 'delete', result: 'absent' }))).toBe('absent')
  })

  test('tryClaim records a key once across concurrent claims', async () => {
    const store = create()
    const expires = Date.now() + 60_000
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Store.tryClaim(store, 'nonce', expires)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await store.get('nonce')).toEqual({ expires, type: 'mppx:replay' })
    expect(await Store.tryClaim(store, 'past', Date.now() - 1)).toBe(false)
  })

  test('tryClaim replaces expired markers, from put or from update', async () => {
    const store = create()
    const expires = Date.now() + 60_000
    await store.put('put', { expires: Date.now() - 1, type: 'mppx:replay' })
    await store.update('updated', () => ({
      op: 'set',
      value: { expires: Date.now() - 1, type: 'mppx:replay' },
      result: undefined,
    }))
    expect(await Store.tryClaim(store, 'put', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'updated', expires)).toBe(true)
    expect(await Store.tryClaim(store, 'put', expires)).toBe(false)
  })

  test('tryClaim keeps live markers and other values', async () => {
    const store = create()
    const expires = Date.now() + 60_000
    await store.put('live', { expires: Date.now() + 30_000, type: 'mppx:replay' })
    await store.put('legacy', Date.now() - 60_000)
    await store.put('other', { expires: Date.now() - 1, type: 'something-else' })
    expect(await Store.tryClaim(store, 'live', expires)).toBe(false)
    expect(await Store.tryClaim(store, 'legacy', expires)).toBe(false)
    expect(await Store.tryClaim(store, 'other', expires)).toBe(false)
    expect(await store.get('other')).toEqual({
      expires: expect.any(Number),
      type: 'something-else',
    })
  })

  test('applies keyPrefix', async () => {
    const store = create({ keyPrefix: 'tenant:' })
    await store.put('k', 'value')
    expect(await store.get('k')).toBe('value')
    expect(await Store.tryClaim(store, 'n', Date.now() + 60_000)).toBe(true)
    expect(await Store.tryClaim(store, 'n', Date.now() + 60_000)).toBe(false)
  })
})

describe('durableObject', () => {
  test('update throws after maxAttempts conflicts without a final backoff', async () => {
    // Every swap reports a conflict.
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_input: string, init: RequestInit) =>
          Response.json(
            JSON.parse(init.body as string).op === 'swap' ? { applied: false, current: '1' } : '1',
          ),
      }),
    }
    const store = Store.durableObject(namespace, { maxAttempts: 3 })
    const setTimeout = vi.spyOn(globalThis, 'setTimeout')
    await expect(
      store.update('k', () => ({ op: 'set', value: 2, result: undefined })),
    ).rejects.toThrow('conflicted 3 times')
    // Backoffs only between attempts.
    expect(setTimeout).toHaveBeenCalledTimes(2)
    setTimeout.mockRestore()
  })
})

describe('sql', () => {
  test('leaves the table to migrations with createTable: false', async () => {
    await expect(pgliteStore({ createTable: false }).get('k')).rejects.toThrow()
    await expect(
      Store.sqlite(new DatabaseSync(':memory:'), { createTable: false }).get('k'),
    ).rejects.toThrow()
  })

  test('rejects table names that are not identifiers', () => {
    expect(() =>
      Store.sql({ dialect: 'sqlite', query: async () => [] }, { table: 'store; DROP TABLE x' }),
    ).toThrow('Invalid SQL store table name')
  })

  test('numbers placeholders for Postgres and keeps them for SQLite', async () => {
    const seen: Record<string, string[]> = { postgres: [], sqlite: [] }
    for (const dialect of ['postgres', 'sqlite'] as const)
      await Store.sql(
        {
          dialect,
          async query(text) {
            seen[dialect]!.push(text)
            return []
          },
        },
        { createTable: false },
      ).put('k', 1)
    expect(seen.postgres![0]).toContain('VALUES ($1, $2, $3)')
    expect(seen.sqlite![0]).toContain('VALUES (?, ?, ?)')
  })

  test('accepts Postgres clients that resolve to rows', async () => {
    const rows = [{ value: '"v"' }]
    const store = Store.postgres({ query: async () => rows }, { createTable: false })
    expect(await store.get('k')).toBe('v')
  })

  test('gives up after maxAttempts conflicts', async () => {
    const store = Store.sql(
      {
        dialect: 'sqlite',
        // Every read sees a value and every swap misses it.
        query: async (text) => (text.startsWith('SELECT') ? [{ value: '1' }] : []),
      },
      { createTable: false, maxAttempts: 2 },
    )
    const setTimeout = vi.spyOn(globalThis, 'setTimeout')
    await expect(
      store.update('k', () => ({ op: 'set', value: 2, result: undefined })),
    ).rejects.toThrow('conflicted 2 times')
    // One backoff between the two attempts, none after the last.
    expect(setTimeout).toHaveBeenCalledTimes(1)
    setTimeout.mockRestore()
  })

  test('retries table creation after a failure', async () => {
    let fail = true
    const store = Store.sql({
      dialect: 'sqlite',
      async query(text) {
        if (text.startsWith('CREATE') && fail) {
          fail = false
          throw new Error('offline')
        }
        return []
      },
    })
    await expect(store.get('k')).rejects.toThrow('offline')
    expect(await store.get('k')).toBeNull()
  })
})

describe('sql compare-and-swap', () => {
  // Another writer changes the value between update's read and its write: the
  // write must miss, and update must retry from the new value.
  async function raceOnce(
    dialect: 'postgres' | 'sqlite',
    run: (text: string, params: unknown[]) => Promise<Store.sql.Row[]>,
  ) {
    let raced = false
    const store = Store.sql({
      dialect,
      async query(text, params) {
        const rows = await run(text, params)
        if (text.startsWith('SELECT') && rows.length > 0 && !raced) {
          raced = true
          await run(
            dialect === 'postgres'
              ? `UPDATE mppx_store SET value = '10' WHERE key = $1`
              : `UPDATE mppx_store SET value = '10' WHERE key = ?`,
            [params[0]],
          )
        }
        return rows
      },
    })
    await store.put('k', 1)
    const result = await store.update('k', (current) => {
      const value = (current as number) + 1
      return { op: 'set', value, result: value }
    })
    expect(raced).toBe(true)
    expect(result).toBe(11)
    expect(await store.get('k')).toBe(11)
  }

  test('postgres (PGlite) retries a write that lost a race', async () => {
    const db = new PGlite()
    await raceOnce(
      'postgres',
      async (text, params) => (await db.query(text, params)).rows as Store.sql.Row[],
    )
  })

  test('sqlite (node:sqlite) retries a write that lost a race', async () => {
    const db = new DatabaseSync(':memory:')
    await raceOnce(
      'sqlite',
      async (text, params) => db.prepare(text).all(...(params as never[])) as Store.sql.Row[],
    )
  })
})
