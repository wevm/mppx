/**
 * Async key-value store interface.
 *
 * Modeled after Cloudflare KV's API (`get`/`put`/`delete`).
 * Implementations handle serialization internally.
 *
 * ## Type architecture
 *
 * Uses a two-slot generic pattern inspired by Viem's `Client` type:
 *
 * - `itemMap` — constrains keys and their value types
 * - `extended` — accumulates additional capabilities (e.g., atomic `update`)
 *
 * `AtomicStore` is a type alias that fills the `extended` slot with
 * `AtomicActions`, just like Viem's `PublicClient = Client<..., PublicActions>`.
 */
import { Json } from 'ox'

import type { MaybePromise } from './internal/types.js'

export type StoreItemMap = Record<string, unknown>

/**
 * Describes the outcome of an atomic {@link Update} callback.
 *
 * - `noop` — leave the stored value unchanged.
 * - `set`  — write `value` for the key.
 * - `delete` — remove the key.
 *
 * Every variant carries a `result` that is forwarded to the caller.
 */
export type Change<value, result> =
  | { op: 'noop'; result: result }
  | { op: 'set'; value: value; result: result }
  | { op: 'delete'; result: result }

/**
 * Atomic read-modify-write for a single key.
 *
 * `fn` receives the current value (or `null`) and returns a {@link Change}
 * describing the write to perform. Implementations may retry `fn`, so it
 * must be synchronous and free of side effects.
 */
export type Update<itemMap extends StoreItemMap = StoreItemMap> = <
  key extends keyof itemMap & string,
  result,
>(
  key: key,
  fn: (current: itemMap[key] | null) => Change<itemMap[key], result>,
) => Promise<result>

/** Attempts to atomically record first use of a replay key. Must reject expires <= Date.now() inside the atomic operation. */
export type TryClaim<itemMap extends StoreItemMap = StoreItemMap> = <
  key extends keyof itemMap & string,
>(
  key: key,
  expires: number,
) => MaybePromise<boolean>

/** Persisted marker used by the {@link tryClaim} fallback. */
export type ReplayMarker = {
  expires: number
  type: 'mppx:replay'
}

/** Base key-value actions available on every {@link Store}. */
export type StoreActions<itemMap extends StoreItemMap = StoreItemMap> = {
  get: <key extends keyof itemMap & string>(key: key) => Promise<itemMap[key] | null>
  put: <key extends keyof itemMap & string>(key: key, value: itemMap[key]) => Promise<void>
  delete: <key extends keyof itemMap & string>(key: key) => Promise<void>
}

/** Atomic actions that can be provided via the `extended` slot. */
export type AtomicActions<itemMap extends StoreItemMap = StoreItemMap> = {
  update: Update<itemMap>
  /** Optional single-operation fast path for recording expiring replay keys. */
  tryClaim?: TryClaim<itemMap> | undefined
}

/**
 * Async key-value store.
 *
 * The second generic `extended` accumulates additional capabilities
 * (like {@link AtomicActions}) without structural patching.
 */
export type Store<
  itemMap extends StoreItemMap = StoreItemMap,
  extended extends Record<string, unknown> | undefined = undefined,
> = StoreActions<itemMap> & (extended extends Record<string, unknown> ? extended : unknown)

/**
 * A {@link Store} whose atomic {@link Update} method is guaranteed to exist.
 *
 * Use this when atomicity is required (e.g., replay protection, channel
 * deductions). Factory functions return `AtomicStore` when the backing
 * adapter provides an `update` implementation.
 *
 * Equivalent to `Store<itemMap, AtomicActions<itemMap>>`.
 */
export type AtomicStore<itemMap extends StoreItemMap = StoreItemMap> = Store<
  itemMap,
  AtomicActions<itemMap>
>

/**
 * Attempts to atomically record first use of a replay key through its expiry.
 *
 * Returns `true` when this call recorded the key and `false` when it was already
 * recorded and unexpired, or the proposed expiry has passed. `expires` is a Unix timestamp in milliseconds.
 * Uses the adapter's optimized primitive when available and otherwise falls
 * back to {@link AtomicStore.update}.
 */
export function tryClaim<itemMap extends StoreItemMap, key extends keyof itemMap & string>(
  store: AtomicStore<itemMap>,
  key: key,
  expires: number,
): MaybePromise<boolean> {
  if (!Number.isFinite(expires) || expires <= Date.now()) return false
  if (store.tryClaim) {
    const result = store.tryClaim(key, expires)
    return typeof result === 'boolean'
      ? result && expires > Date.now()
      : result.then((claimed) => claimed && expires > Date.now())
  }
  return store.update(key, (current) => {
    if (!Number.isFinite(expires) || expires <= Date.now()) return { op: 'noop', result: false }
    if (current !== null && (!isReplayMarker(current) || current.expires > Date.now()))
      return { op: 'noop', result: false }
    return {
      op: 'set',
      value: { expires, type: 'mppx:replay' } as itemMap[key],
      result: true,
    }
  })
}

function isReplayMarker(value: unknown): value is ReplayMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'expires' in value &&
    typeof value.expires === 'number' &&
    'type' in value &&
    value.type === 'mppx:replay'
  )
}

/** Options shared by store constructors. */
export type Options = {
  /** Prefix prepended to every backing store key. */
  keyPrefix?: string | undefined
}

const keyPrefixCache = new WeakMap<Store, Map<string, Store | AtomicStore>>()

/** Creates a {@link Store} from an existing implementation. */
export function from<store extends AtomicStore<any>>(store: store, options?: Options): store
export function from<store extends Store<any>>(store: store, options?: Options): store
export function from(store: Store | AtomicStore, options?: Options) {
  return withKeyPrefix(store, options?.keyPrefix)
}

function withKeyPrefix(store: Store | AtomicStore, keyPrefix = ''): Store | AtomicStore {
  if (!keyPrefix) return store

  const cached = keyPrefixCache.get(store)?.get(keyPrefix)
  if (cached) return cached

  const backing = store as Store
  const prefixedKey = (key: string) => `${keyPrefix}${key}`
  const prefixed = from({
    async get(key: string) {
      return backing.get(prefixedKey(key)) as Promise<unknown>
    },
    async put(key: string, value: unknown) {
      await backing.put(prefixedKey(key), value)
    },
    async delete(key: string) {
      await backing.delete(prefixedKey(key))
    },
    ...('update' in store
      ? {
          async update<result>(
            key: string,
            fn: (current: unknown | null) => Change<unknown, result>,
          ) {
            return (store as AtomicStore).update(prefixedKey(key), fn as never)
          },
        }
      : {}),
    ...('tryClaim' in store && typeof store.tryClaim === 'function'
      ? {
          tryClaim(key: string, expires: number) {
            return store.tryClaim!(prefixedKey(key), expires)
          },
        }
      : {}),
  } satisfies Store | AtomicStore)

  const cachedByPrefix = keyPrefixCache.get(store) ?? new Map<string, Store | AtomicStore>()
  cachedByPrefix.set(keyPrefix, prefixed)
  keyPrefixCache.set(store, cachedByPrefix)
  return prefixed
}

function wrapJsonUpdate(
  update:
    | (<result>(
        key: string,
        fn: (current: string | null) => Change<string, result>,
      ) => Promise<result>)
    | undefined,
): AtomicActions | {} {
  if (!update) return {}
  return {
    async update(key, fn) {
      return update(key, (current) => {
        const parsed = current == null ? null : (Json.parse(current) as never)
        const change = fn(parsed)
        if (change.op !== 'set') return change
        return { ...change, value: Json.stringify(change.value) }
      })
    },
  } satisfies AtomicActions
}

/** Wraps a Cloudflare KV namespace. */
export function cloudflare(
  kv: cloudflare.AtomicParameters,
  options?: cloudflare.Options,
): AtomicStore
export function cloudflare(kv: cloudflare.Parameters, options?: cloudflare.Options): Store
export function cloudflare(kv: cloudflare.Parameters, options?: cloudflare.Options): Store {
  return from(
    {
      async get(key: string) {
        const raw = await kv.get(key)
        if (raw == null) return null as any
        return Json.parse(raw as string)
      },
      async put(key: string, value: unknown) {
        await kv.put(key, Json.stringify(value))
      },
      async delete(key: string) {
        await kv.delete(key)
      },
      ...wrapJsonUpdate(kv.update),
    },
    options,
  )
}

export declare namespace cloudflare {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
  }

  export type Parameters = {
    get: (key: string) => Promise<unknown>
    put: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<void>
    update?: <result>(
      key: string,
      fn: (current: string | null) => Change<string, result>,
    ) => Promise<result>
  }

  export type AtomicParameters = Omit<Parameters, 'update'> & {
    update: NonNullable<Parameters['update']>
  }
}

/**
 * Atomic store backed by Cloudflare Durable Objects.
 *
 * Each key lives in its own Durable Object instance (`idFromName(key)`), so
 * reads and writes of one key are linearizable across every Worker isolate and
 * location, while different keys (such as different payment channels) scale
 * out across instances. {@link AtomicStore.update} runs `fn` in the Worker and
 * commits with a compare-and-swap in the object. When another writer changed
 * the key in between, the swap returns the stored value and the update retries
 * from it after a jittered backoff; {@link AtomicStore.tryClaim} runs in a single
 * object call.
 *
 * Bind {@link DurableObjectStore} as a SQLite-backed Durable Object and pass
 * its namespace.
 *
 * @example
 * ```ts
 * import { Store } from 'mppx/server'
 *
 * export class MppxStore extends Store.DurableObjectStore {}
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     const store = Store.durableObject(env.MPPX_STORE)
 *     // ...
 *   },
 * }
 * ```
 */
export function durableObject(
  namespace: durableObject.Namespace,
  options?: durableObject.Options,
): AtomicStore {
  const maxAttempts = options?.maxAttempts ?? 32

  async function call<result>(key: string, body: DurableObjectStore.Request): Promise<result> {
    const stub = namespace.get(namespace.idFromName(key))
    const response = await stub.fetch('https://mppx-store/', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!response.ok)
      throw new Error(
        `Durable Object store request failed (${response.status}): ${await response.text()}`,
      )
    return (await response.json()) as result
  }

  return from(
    {
      async get(key: string) {
        const raw = await call<string | null>(key, { op: 'get', key })
        if (raw == null) return null as any
        return Json.parse(raw)
      },
      async put(key: string, value: unknown) {
        await call(key, { op: 'put', key, value: Json.stringify(value) })
      },
      async delete(key: string) {
        await call(key, { op: 'delete', key })
      },
      async update<result>(key: string, fn: (current: unknown | null) => Change<unknown, result>) {
        let raw = await call<string | null>(key, { op: 'get', key })
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const change = fn(raw == null ? null : (Json.parse(raw) as never))
          if (change.op === 'noop') return change.result
          const swapped = await call<DurableObjectStore.SwapResult>(key, {
            op: 'swap',
            key,
            expected: raw,
            value: change.op === 'set' ? Json.stringify(change.value) : null,
          })
          if (swapped.applied) return change.result
          // Lost a race: retry from the value the object returned, after a jittered backoff.
          raw = swapped.current
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * Math.min(2 ** (attempt + 1), 200)),
          )
        }
        throw new Error(`Durable Object store update of "${key}" conflicted ${maxAttempts} times.`)
      },
      async tryClaim(key: string, expires: number) {
        if (!Number.isFinite(expires) || expires <= Date.now()) return false
        return call<boolean>(key, { op: 'claim', key, expires })
      },
    },
    options,
  )
}

export declare namespace durableObject {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
    /** Compare-and-swap attempts before {@link AtomicStore.update} gives up. @default 32 */
    maxAttempts?: number | undefined
  }

  /** The Durable Object namespace binding of a {@link DurableObjectStore} class. */
  export type Namespace = {
    idFromName: (name: string) => unknown
    get: (id: any) => {
      fetch: (input: string, init: RequestInit) => Promise<Response>
    }
  }
}

/**
 * Durable Object class that holds the values of {@link durableObject}.
 *
 * Export a subclass of it from your Worker and bind it in
 * `wrangler.jsonc` with a `new_sqlite_classes` migration. It needs no
 * `cloudflare:workers` import, so it bundles anywhere.
 *
 * @example
 * ```jsonc
 * {
 *   "durable_objects": { "bindings": [{ "name": "MPPX_STORE", "class_name": "MppxStore" }] },
 *   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MppxStore"] }]
 * }
 * ```
 */
export class DurableObjectStore {
  readonly #storage: DurableObjectStore.Storage

  constructor(state: { storage: DurableObjectStore.Storage }, _env?: unknown) {
    this.#storage = state.storage
  }

  /** Handles one store operation. Each runs without awaiting other I/O between its read and write, so the object's input gate makes it atomic. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const body = (await request.json()) as DurableObjectStore.Request
    const storage = this.#storage
    const read = async () => ((await storage.get(body.key)) as string | undefined) ?? null
    const write = async (value: string | null) => {
      if (value === null) await storage.delete(body.key)
      else await storage.put(body.key, value)
    }

    switch (body.op) {
      case 'get':
        return Response.json(await read())
      case 'put':
        await write(body.value)
        return Response.json(true)
      case 'delete':
        await write(null)
        return Response.json(true)
      case 'swap': {
        const current = await read()
        if (current !== body.expected)
          return Response.json({ applied: false, current } satisfies DurableObjectStore.SwapResult)
        await write(body.value)
        return Response.json({ applied: true } satisfies DurableObjectStore.SwapResult)
      }
      case 'claim': {
        const { expires } = body
        if (!Number.isFinite(expires) || expires <= Date.now()) return Response.json(false)
        const raw = await read()
        const current = raw == null ? null : Json.parse(raw)
        if (current !== null && (!isReplayMarker(current) || current.expires > Date.now()))
          return Response.json(false)
        await write(Json.stringify({ expires, type: 'mppx:replay' } satisfies ReplayMarker))
        return Response.json(true)
      }
      default:
        return new Response('Unknown operation', { status: 400 })
    }
  }
}

export declare namespace DurableObjectStore {
  /** The subset of `DurableObjectStorage` the store uses. */
  export type Storage = {
    get: (key: string) => Promise<unknown>
    put: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<unknown>
  }

  /** Result of a compare-and-swap: on a conflict, the stored value, so a retry needs no read. */
  export type SwapResult = { applied: true } | { applied: false; current: string | null }

  /** An operation sent from {@link durableObject} to the object. */
  export type Request =
    | { op: 'get'; key: string }
    | { op: 'put'; key: string; value: string }
    | { op: 'delete'; key: string }
    | { op: 'swap'; key: string; expected: string | null; value: string | null }
    | { op: 'claim'; key: string; expires: number }
}

/**
 * Atomic store backed by a SQL database: Postgres, SQLite or Cloudflare D1.
 *
 * Values live as JSON text in one table (`mppx_store` by default, created on
 * first use). Every write is a single statement, and {@link AtomicStore.update}
 * commits with a compare-and-swap on the stored value
 * (`UPDATE … WHERE key = ? AND value = ? RETURNING`, or
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` for a new key), retrying from the
 * current value after a jittered backoff when another writer won. It needs no
 * interactive transactions, so it works over HTTP drivers and D1, and only
 * `ON CONFLICT` and `RETURNING` (Postgres, SQLite 3.35+, D1, libSQL).
 *
 * Use {@link postgres}, {@link sqlite} or {@link d1} for common drivers, or pass
 * any driver as a `query` function.
 *
 * @example
 * ```ts
 * import postgres from 'postgres'
 * import { Store } from 'mppx/server'
 *
 * const db = postgres(process.env.DATABASE_URL!)
 * const store = Store.sql({ dialect: 'postgres', query: (text, params) => db.unsafe(text, params) })
 * ```
 */
export function sql(driver: sql.Driver, options?: sql.Options): AtomicStore {
  const table = options?.table ?? 'mppx_store'
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(table))
    throw new Error(`Invalid SQL store table name: "${table}".`)
  const maxAttempts = options?.maxAttempts ?? 32

  // Statements are written with `?`; Postgres numbers its placeholders.
  const prepare = (text: string) => {
    if (driver.dialect !== 'postgres') return text
    let index = 0
    return text.replace(/\?/g, () => `$${++index}`)
  }

  let ready: Promise<void> | undefined
  const ensureTable = () => {
    if (options?.createTable === false) return
    ready ??= Promise.resolve(
      driver.query(
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        [],
      ),
    ).then(
      () => {},
      (error) => {
        ready = undefined
        throw error
      },
    )
    return ready
  }

  async function query(text: string, params: unknown[]): Promise<sql.Row[]> {
    await ensureTable()
    return driver.query(prepare(text), params)
  }

  async function read(key: string): Promise<string | null> {
    const [row] = await query(`SELECT value FROM ${table} WHERE key = ?`, [key])
    return row ? (row.value as string) : null
  }

  /** Writes `value` (or deletes, for `null`) only if the key still holds `expected`. */
  async function swap(key: string, expected: string | null, value: string | null) {
    if (expected === null) {
      if (value === null) return true
      const rows = await query(
        `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, value],
      )
      return rows.length > 0
    }
    const rows =
      value === null
        ? await query(`DELETE FROM ${table} WHERE key = ? AND value = ? RETURNING key`, [
            key,
            expected,
          ])
        : await query(`UPDATE ${table} SET value = ? WHERE key = ? AND value = ? RETURNING key`, [
            value,
            key,
            expected,
          ])
    return rows.length > 0
  }

  return from(
    {
      async get(key: string) {
        const raw = await read(key)
        if (raw == null) return null as any
        return Json.parse(raw)
      },
      async put(key: string, value: unknown) {
        await query(
          `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          [key, Json.stringify(value)],
        )
      },
      async delete(key: string) {
        await query(`DELETE FROM ${table} WHERE key = ?`, [key])
      },
      async update<result>(key: string, fn: (current: unknown | null) => Change<unknown, result>) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const raw = await read(key)
          const change = fn(raw == null ? null : (Json.parse(raw) as never))
          if (change.op === 'noop') return change.result
          const value = change.op === 'set' ? Json.stringify(change.value) : null
          if (await swap(key, raw, value)) return change.result
          // Lost a race: retry from the new value after a jittered backoff.
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * Math.min(2 ** (attempt + 1), 200)),
          )
        }
        throw new Error(`SQL store update of "${key}" conflicted ${maxAttempts} times.`)
      },
    },
    options,
  )
}

export declare namespace sql {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
    /** Compare-and-swap attempts before {@link AtomicStore.update} gives up. @default 32 */
    maxAttempts?: number | undefined
    /** Table holding the values, optionally schema-qualified. @default 'mppx_store' */
    table?: string | undefined
    /** Create the table on first use (`CREATE TABLE IF NOT EXISTS`). Set `false` when migrations create it. @default true */
    createTable?: boolean | undefined
  }

  /** A result row. */
  export type Row = Record<string, unknown>

  /** Runs one statement with positional parameters and returns its rows. */
  export type Driver = {
    /** Placeholder style: Postgres numbers them (`$1`), SQLite and D1 use `?`. */
    dialect: 'postgres' | 'sqlite'
    query: (sql: string, params: unknown[]) => Promise<Row[]>
  }
}

/**
 * Atomic SQL store on a Postgres client: `pg` (`Pool` or `Client`),
 * `@neondatabase/serverless` (`Pool` or `neon()`), `@vercel/postgres`,
 * Supabase's Postgres connection or PGlite. See {@link sql}.
 *
 * @example
 * ```ts
 * import { Pool } from 'pg'
 * import { Store } from 'mppx/server'
 *
 * const store = Store.postgres(new Pool({ connectionString: process.env.DATABASE_URL }))
 * ```
 */
export function postgres(client: postgres.Client, options?: sql.Options): AtomicStore {
  return sql(
    {
      dialect: 'postgres',
      async query(text, params) {
        const result = await client.query(text, params)
        return Array.isArray(result) ? result : result.rows
      },
    },
    options,
  )
}

export declare namespace postgres {
  /** Any client with `query(text, values)` that resolves to `{ rows }` or to the rows. */
  export type Client = {
    query: (text: string, values: unknown[]) => Promise<{ rows: sql.Row[] } | sql.Row[]>
  }
}

/**
 * Atomic SQL store on a SQLite database: `node:sqlite` (`DatabaseSync`),
 * `better-sqlite3` or `bun:sqlite`. See {@link sql}. For libSQL or Turso, pass
 * `client.execute` to {@link sql} with dialect `sqlite`.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from 'node:sqlite'
 * import { Store } from 'mppx/server'
 *
 * const store = Store.sqlite(new DatabaseSync('mppx.db'))
 * ```
 */
export function sqlite(database: sqlite.Database, options?: sql.Options): AtomicStore {
  return sql(
    {
      dialect: 'sqlite',
      async query(text, params) {
        return (await database.prepare(text).all(...params)) as sql.Row[]
      },
    },
    options,
  )
}

export declare namespace sqlite {
  /** A database whose prepared statements run with `all(...params)`. */
  export type Database = {
    prepare: (sql: string) => { all: (...params: any[]) => unknown }
  }
}

/**
 * Atomic SQL store on a Cloudflare D1 database binding. See {@link sql}.
 *
 * @example
 * ```ts
 * import { Store } from 'mppx/server'
 *
 * export default {
 *   fetch(request: Request, env: { DB: D1Database }) {
 *     const store = Store.d1(env.DB)
 *     // ...
 *   },
 * }
 * ```
 */
export function d1(database: d1.Database, options?: sql.Options): AtomicStore {
  return sql(
    {
      dialect: 'sqlite',
      async query(text, params) {
        const { results } = await database
          .prepare(text)
          .bind(...params)
          .all()
        return results as sql.Row[]
      },
    },
    options,
  )
}

export declare namespace d1 {
  /** The subset of `D1Database` the store uses. */
  export type Database = {
    prepare: (sql: string) => {
      bind: (...values: any[]) => { all: () => Promise<{ results: unknown[] }> }
    }
  }
}

/** In-memory store backed by a `Map`. JSON-roundtrips values to match production behavior. */
export function memory(options?: memory.Options): AtomicStore {
  const store = new Map<string, string>()
  return from(
    {
      async get(key: string) {
        const raw = store.get(key)
        if (raw === undefined) return null as any
        return Json.parse(raw)
      },
      async put(key: string, value: unknown) {
        store.set(key, Json.stringify(value))
      },
      async delete(key: string) {
        store.delete(key)
      },
      async update<result>(key: string, fn: (current: unknown | null) => Change<unknown, result>) {
        const current = store.has(key) ? (Json.parse(store.get(key)!) as never) : null
        const change = fn(current)
        if (change.op === 'set') store.set(key, Json.stringify(change.value))
        if (change.op === 'delete') store.delete(key)
        return change.result
      },
      tryClaim(key: string, expires: number) {
        if (!Number.isFinite(expires) || expires <= Date.now()) return false
        const current = store.has(key) ? Json.parse(store.get(key)!) : null
        if (current !== null && (!isReplayMarker(current) || current.expires > Date.now()))
          return false
        store.set(key, Json.stringify({ expires, type: 'mppx:replay' }))
        return true
      },
    },
    options,
  )
}

export declare namespace memory {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
  }
}

/** Wraps a standard Redis client (ioredis, node-redis, Valkey). */
export function redis(client: redis.AtomicParameters, options?: redis.Options): AtomicStore
export function redis(client: redis.Parameters, options?: redis.Options): Store
export function redis(client: redis.Parameters, options?: redis.Options): Store {
  return from(
    {
      async get(key: string) {
        const raw = await client.get(key)
        if (raw == null) return null as any
        return Json.parse(raw)
      },
      async put(key: string, value: unknown) {
        await client.set(key, Json.stringify(value))
      },
      async delete(key: string) {
        await client.del(key)
      },
      ...wrapJsonUpdate(client.update),
    },
    options,
  )
}

export declare namespace redis {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
  }

  export type Parameters = {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<unknown>
    del: (key: string) => Promise<unknown>
    update?: <result>(
      key: string,
      fn: (current: string | null) => Change<string, result>,
    ) => Promise<result>
  }

  export type AtomicParameters = Omit<Parameters, 'update'> & {
    update: NonNullable<Parameters['update']>
  }
}

/** Wraps an Upstash Redis instance (e.g. Vercel KV). */
export function upstash(redis: upstash.AtomicParameters, options?: upstash.Options): AtomicStore
export function upstash(redis: upstash.Parameters, options?: upstash.Options): Store
export function upstash(redis: upstash.Parameters, options?: upstash.Options): Store {
  return from(
    {
      async get(key: string) {
        return (await redis.get(key)) as any
      },
      async put(key: string, value: unknown) {
        await redis.set(key, value)
      },
      async delete(key: string) {
        await redis.del(key)
      },
      ...(redis.update
        ? {
            update: redis.update as Update,
          }
        : {}),
    },
    options,
  )
}

export declare namespace upstash {
  export type Options = {
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
  }

  export type Parameters = {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<unknown>
    del: (key: string) => Promise<unknown>
    update?: <result>(
      key: string,
      fn: (current: unknown | null) => Change<unknown, result>,
    ) => Promise<result>
  }

  export type AtomicParameters = Omit<Parameters, 'update'> & {
    update: NonNullable<Parameters['update']>
  }
}
