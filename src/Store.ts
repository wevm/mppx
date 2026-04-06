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

/** Base key-value actions available on every {@link Store}. */
export type StoreActions<itemMap extends StoreItemMap = StoreItemMap> = {
  get: <key extends keyof itemMap & string>(key: key) => Promise<itemMap[key] | null>
  put: <key extends keyof itemMap & string>(key: key, value: itemMap[key]) => Promise<void>
  delete: <key extends keyof itemMap & string>(key: key) => Promise<void>
}

/** Atomic actions that can be provided via the `extended` slot. */
export type AtomicActions<itemMap extends StoreItemMap = StoreItemMap> = {
  update: Update<itemMap>
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

/** Creates a {@link Store} from an existing implementation. */
export function from<store extends Store>(store: store): store
export function from<store extends AtomicStore>(store: store): store
export function from(store: Store | AtomicStore) {
  return store
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
export function cloudflare(kv: cloudflare.AtomicParameters): AtomicStore
export function cloudflare(kv: cloudflare.Parameters): Store
export function cloudflare(kv: cloudflare.Parameters): Store {
  return from({
    async get(key) {
      const raw = await kv.get(key)
      if (raw == null) return null as any
      return Json.parse(raw as string)
    },
    async put(key, value) {
      await kv.put(key, Json.stringify(value))
    },
    async delete(key) {
      await kv.delete(key)
    },
    ...wrapJsonUpdate(kv.update),
  })
}

export declare namespace cloudflare {
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

/** In-memory store backed by a `Map`. JSON-roundtrips values to match production behavior. */
export function memory(): AtomicStore {
  const store = new Map<string, string>()
  return from({
    async get(key) {
      const raw = store.get(key)
      if (raw === undefined) return null as any
      return Json.parse(raw)
    },
    async put(key, value) {
      store.set(key, Json.stringify(value))
    },
    async delete(key) {
      store.delete(key)
    },
    async update(key, fn) {
      const current = store.has(key) ? (Json.parse(store.get(key)!) as never) : null
      const change = fn(current)
      if (change.op === 'set') store.set(key, Json.stringify(change.value))
      if (change.op === 'delete') store.delete(key)
      return change.result
    },
  })
}

/** Wraps a standard Redis client (ioredis, node-redis, Valkey). */
export function redis(client: redis.AtomicParameters): AtomicStore
export function redis(client: redis.Parameters): Store
export function redis(client: redis.Parameters): Store {
  return from({
    async get(key) {
      const raw = await client.get(key)
      if (raw == null) return null as any
      return Json.parse(raw)
    },
    async put(key, value) {
      await client.set(key, Json.stringify(value))
    },
    async delete(key) {
      await client.del(key)
    },
    ...wrapJsonUpdate(client.update),
  })
}

export declare namespace redis {
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
export function upstash(redis: upstash.AtomicParameters): AtomicStore
export function upstash(redis: upstash.Parameters): Store
export function upstash(redis: upstash.Parameters): Store {
  return from({
    async get(key) {
      return (await redis.get(key)) as any
    },
    async put(key, value) {
      await redis.set(key, value)
    },
    async delete(key) {
      await redis.del(key)
    },
    ...(redis.update
      ? {
          update: redis.update as Update,
        }
      : {}),
  })
}

export declare namespace upstash {
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
