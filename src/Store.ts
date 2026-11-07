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

/**
 * Runs `fn` on the stored value and commits its change with `swap`, a
 * compare-and-swap. When another writer won, retries from the value `swap`
 * returned (or a fresh read) after a jittered backoff. Values cross `read` and
 * `swap` as JSON text unless `decode` and `encode` say otherwise.
 */
async function compareAndSwap<result, raw = string>(parameters: {
  decode?: ((raw: raw) => unknown) | undefined
  encode?: ((value: unknown) => raw) | undefined
  fn: (current: unknown | null) => Change<unknown, result>
  key: string
  label: string
  maxAttempts: number
  read: () => Promise<raw | null>
  swap: (
    expected: raw | null,
    value: raw | null,
  ) => Promise<{ applied: boolean; current?: raw | null | undefined }>
}): Promise<result> {
  const { fn, key, label, maxAttempts, read, swap } = parameters
  const decode = parameters.decode ?? ((raw: raw) => Json.parse(raw as string))
  const encode = parameters.encode ?? ((value: unknown) => Json.stringify(value) as raw)
  let raw: raw | null = await read()
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const change = fn(raw == null ? null : (decode(raw) as never))
    if (change.op === 'noop') return change.result
    const swapped = await swap(raw, change.op === 'set' ? encode(change.value) : null)
    if (swapped.applied) return change.result
    if (attempt + 1 === maxAttempts) break
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * Math.min(2 ** (attempt + 1), 200)),
    )
    raw = swapped.current !== undefined ? swapped.current : await read()
  }
  throw new Error(`${label} update of "${key}" conflicted ${maxAttempts} times.`)
}

/** Object types native compare-and-swap compares by value, besides arrays, plain objects, maps, sets and typed arrays. */
const comparableTags = new Set([
  '[object ArrayBuffer]',
  '[object BigInt]',
  '[object Boolean]',
  '[object Date]',
  '[object Number]',
  '[object RegExp]',
  '[object String]',
])

/** The error for a value native compare-and-swap cannot compare, which would otherwise conflict until `maxAttempts`. */
function incomparable(what: string): Error {
  return new Error(`Store.durableObject: native encoding cannot compare ${what}.`)
}

/** Throws unless map keys and set members are primitives, compared like `Map#has` (SameValueZero). */
function assertPrimitiveKey(key: unknown, tag: string): void {
  if ((typeof key === 'object' && key !== null) || typeof key === 'function')
    throw incomparable(`a ${tag.slice(8, -1)} with object keys`)
}

/**
 * Throws for a value that native compare-and-swap cannot compare, so a write
 * fails at once instead of making later updates conflict until `maxAttempts`.
 */
function assertComparable(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return
  // Structured clone keeps cycles: check each object once.
  if (seen.has(value)) return
  seen.add(value)
  const tag = Object.prototype.toString.call(value)
  if (Array.isArray(value) || tag === '[object Object]')
    for (const key of Object.keys(value))
      assertComparable((value as Record<string, unknown>)[key], seen)
  else if (value instanceof Map)
    for (const [key, item] of value) {
      assertPrimitiveKey(key, tag)
      assertComparable(item, seen)
    }
  else if (value instanceof Set) for (const item of value) assertPrimitiveKey(item, tag)
  else if (!comparableTags.has(tag)) throw incomparable(`${tag.slice(8, -1)} values`)
}

/** An `ArrayBuffer`'s resizable state, which older TypeScript libs leave out. */
type Resizable = { maxByteLength?: number; resizable?: boolean }

/** `SameValueZero`, how maps and sets match keys. */
function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b)
}

/** A view's bytes. */
function bytesOf(view: ArrayBufferView | ArrayBuffer): Uint8Array {
  return ArrayBuffer.isView(view)
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array(view)
}

/**
 * Structural equality of stored values, as structured clone copies them:
 * primitives (bigints by value), arrays (holes included) and plain objects, maps
 * and sets, all in key or insertion order, typed arrays, `DataView`s and `ArrayBuffer`s (type and bytes), dates,
 * regular expressions and boxed primitives. A native compare-and-swap
 * needs it, since a value read back from storage is a copy. Throws for values it
 * cannot compare, rather than reporting a conflict that never resolves.
 */
function deepEqual(
  a: unknown,
  b: unknown,
  pairs: [Map<object, object>, Map<object, object>] = [new Map(), new Map()],
): boolean {
  if (a === b || (a !== a && b !== b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // Pair objects one-to-one, both ways: a pair already being compared is assumed equal, so
  // cyclic values terminate, and an object paired with another fails, so aliasing and cycle
  // shapes, which structured clone keeps, must match.
  const [left, right] = pairs
  if (left.has(a) || right.has(b)) return left.get(a) === b && right.get(b) === a
  left.set(a, b)
  right.set(b, a)
  const tag = Object.prototype.toString.call(a)
  if (tag !== Object.prototype.toString.call(b)) return false
  // Arrays and plain objects: own enumerable keys in order (array indexes first, so holes,
  // sparse lengths and named properties count, and inherited indexes don't), then values.
  // Structured clone keeps key order, so values that differ only in order are different values.
  if (Array.isArray(a) || tag === '[object Object]') {
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false
    const keys = Object.keys(a)
    const other = Object.keys(b)
    return (
      keys.length === other.length &&
      keys.every(
        (key, i) =>
          key === other[i] &&
          deepEqual(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            pairs,
          ),
      )
    )
  }
  // Structured clone keeps a view's whole backing buffer and offset, not only its visible bytes.
  if (ArrayBuffer.isView(a)) {
    const other = b as ArrayBufferView
    return (
      a.byteOffset === other.byteOffset &&
      a.byteLength === other.byteLength &&
      deepEqual(a.buffer, other.buffer, pairs)
    )
  }
  if (tag === '[object ArrayBuffer]') {
    const x = a as ArrayBuffer & Resizable
    const y = b as ArrayBuffer & Resizable
    // Structured clone keeps whether a buffer is resizable, and up to what length.
    if (x.resizable !== y.resizable || x.maxByteLength !== y.maxByteLength) return false
    const xs = bytesOf(x)
    const ys = bytesOf(y)
    return xs.length === ys.length && xs.every((byte, i) => byte === ys[i])
  }
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>
    if (a.size !== other.size) return false
    // In insertion order, which structured clone keeps.
    const entries = other.entries()
    for (const [key, item] of a) {
      assertPrimitiveKey(key, tag)
      const [otherKey, otherItem] = entries.next().value!
      if (!sameValueZero(key, otherKey) || !deepEqual(item, otherItem, pairs)) return false
    }
    return true
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>
    if (a.size !== other.size) return false
    const items = other.values()
    for (const item of a) {
      assertPrimitiveKey(item, tag)
      if (!sameValueZero(item, items.next().value)) return false
    }
    return true
  }
  if (a instanceof RegExp)
    return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags
  if (comparableTags.has(tag)) return Object.is(a.valueOf(), (b as object).valueOf())
  throw incomparable(`${tag.slice(8, -1)} values`)
}

/** 32-bit FNV-1a hash of a string's UTF-16 code units: cheap and stable, to pick a replay shard. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
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
 * its namespace. With `transport: 'rpc'`, the store calls the object's methods
 * over Workers RPC instead of `fetch`, and `encoding: 'native'` then stores
 * values as structured-clone values instead of JSON text.
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
 *
 * @example
 * ```ts
 * import { DurableObject } from 'cloudflare:workers'
 * import { Store } from 'mppx/server'
 *
 * // Workers RPC needs a class that extends `DurableObject`.
 * export class MppxStore extends Store.DurableObjectStore.rpc(DurableObject) {}
 *
 * const store = Store.durableObject(env.MPPX_STORE, { transport: 'rpc', encoding: 'native' })
 * ```
 */
export function durableObject(
  namespace: durableObject.Namespace,
  options?: durableObject.Options,
): AtomicStore {
  const maxAttempts = options?.maxAttempts ?? 32
  const transport = options?.transport ?? 'fetch'
  const encoding = options?.encoding ?? 'json'
  if (encoding === 'native' && transport !== 'rpc')
    throw new Error(
      'Store.durableObject: `encoding: "native"` requires `transport: "rpc"`, since `fetch` carries values as JSON.',
    )
  const native = encoding === 'native'
  const { replayShards, replayShardVersion = 1 } = options ?? {}
  if (replayShards !== undefined && !(Number.isSafeInteger(replayShards) && replayShards > 0))
    throw new Error(
      `Store.durableObject: \`replayShards\` must be a positive integer, got ${replayShards}.`,
    )
  if (!(Number.isSafeInteger(replayShardVersion) && replayShardVersion > 0))
    throw new Error(
      `Store.durableObject: \`replayShardVersion\` must be a positive integer, got ${replayShardVersion}.`,
    )

  const object = (key: string) => namespace.get(namespace.idFromName(key))

  async function call<result>(key: string, body: DurableObjectStore.Request): Promise<result> {
    const response = await object(key).fetch('https://mppx-store/', {
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

  // The object's operations on stored values: JSON text, or native values over RPC.
  const remote: DurableObjectStore.Stub =
    transport === 'rpc'
      ? {
          get: (key) => stub(key).get(key, encoding),
          put: (key, value) => stub(key).put(key, value, encoding),
          delete: (key) => stub(key).delete(key, encoding),
          swap: (key, expected, value) => stub(key).swap(key, expected, value, encoding),
          claim: (key, expires) => stub(key).claim(key, expires, encoding),
        }
      : {
          get: (key) => call(key, { op: 'get', key }),
          put: (key, value) => call(key, { op: 'put', key, value: value as string }),
          delete: (key) => call(key, { op: 'delete', key }),
          swap: (key, expected, value) =>
            call(key, {
              op: 'swap',
              key,
              expected: expected as string | null,
              value: value as string | null,
            }),
          claim: (key, expires) => call(key, { op: 'claim', key, expires }),
        }
  function stub(key: string) {
    return object(key) as unknown as DurableObjectStore.Stub
  }

  // Replay claims in `replayShards` SQLite-backed shard objects instead of one object per key.
  const replay =
    replayShards === undefined
      ? undefined
      : (() => {
          const shardOf = (key: string) =>
            `mppx:replay:v${replayShardVersion}:${fnv1a(key) % replayShards}`
          const shard = (key: string) =>
            object(shardOf(key)) as unknown as DurableObjectStore.ReplayShard
          return transport === 'rpc'
            ? {
                claim: (key: string, expires: number) => shard(key).claimReplay(key, expires),
                release: (key: string) => shard(key).releaseReplay(key),
              }
            : {
                claim: (key: string, expires: number) =>
                  call<boolean>(shardOf(key), { op: 'claimReplay', key, expires }),
                release: (key: string) => call(shardOf(key), { op: 'releaseReplay', key }),
              }
        })()

  return from(
    {
      async get(key: string) {
        const raw = await remote.get(key)
        if (raw == null) return null as any
        return native ? raw : Json.parse(raw as string)
      },
      async put(key: string, value: unknown) {
        if (native) assertComparable(value)
        await remote.put(key, native ? value : Json.stringify(value))
      },
      async delete(key: string) {
        // Callers release a claim by deleting its key (tempo charge does when a payment
        // fails), and claims take any caller-chosen key and prefix, so every delete also
        // releases the key's shard claim: one idempotent `DELETE`.
        await Promise.all([remote.delete(key), replay?.release(key)])
      },
      update<result>(key: string, fn: (current: unknown | null) => Change<unknown, result>) {
        return compareAndSwap<result, unknown>({
          // A native value is the compare-and-swap's expected value, so `fn` gets a copy.
          decode: native ? (raw) => structuredClone(raw) : (raw) => Json.parse(raw as string),
          encode: native
            ? (value) => {
                assertComparable(value)
                return value
              }
            : (value) => Json.stringify(value),
          fn,
          key,
          label: 'Durable Object store',
          maxAttempts,
          read: async () => (await remote.get(key)) ?? null,
          swap: (expected, value) => remote.swap(key, expected, value),
        })
      },
      async tryClaim(key: string, expires: number) {
        if (!Number.isFinite(expires) || expires <= Date.now()) return false
        return replay ? replay.claim(key, expires) : remote.claim(key, expires)
      },
    },
    options,
  )
}

export declare namespace durableObject {
  export type Options = {
    /**
     * How values are stored. `json` stores JSON text (bigints as ox encodes them);
     * `native` stores structured-clone values, so bigints and nested objects stay
     * intact and values written directly with `storage.put` read back. `native`
     * requires `transport: 'rpc'`. Stored values don't record their encoding, so keep
     * one encoding per namespace (or `keyPrefix`): a `native` store reads `json` values
     * as their JSON text, and `json` clients cannot read what it writes. @default 'json'
     */
    encoding?: Encoding | undefined
    /** Prefix prepended to every backing store key. */
    keyPrefix?: string | undefined
    /** Compare-and-swap attempts before {@link AtomicStore.update} gives up. @default 32 */
    maxAttempts?: number | undefined
    /**
     * Spreads replay claims ({@link AtomicStore.tryClaim}) over this many shard
     * objects, named `mppx:replay:v<version>:<shard>` by an FNV-1a hash of the
     * key, instead of one object per key: each shard holds its claims in a SQLite
     * table (`mppx_replay_claims`) and clears expired ones with an alarm, so short-lived claims leave no
     * objects behind. The class must be SQLite-backed. Claims then live only in
     * the shards: `get` and `update` of a claimed key don't see them, and
     * `delete` releases them. Changing the count moves keys between shards, so
     * bump `replayShardVersion` with it to start from empty shards. A claim lives
     * only where it was made: enabling sharding, changing the count or version, or
     * running two settings side by side lets a key claimed under the old setting
     * be claimed again until that claim expires. Change it when no unexpired
     * claim matters, such as together with the secret that signs Challenges.
     */
    replayShards?: number | undefined
    /** Version in the shard objects' names, to start a fresh set of shards. @default 1 */
    replayShardVersion?: number | undefined
    /**
     * How the store calls the object: `fetch` requests, or Workers RPC method
     * calls, which need the class from {@link DurableObjectStore.rpc}. @default 'fetch'
     */
    transport?: 'fetch' | 'rpc' | undefined
  }

  /** How {@link durableObject} stores values: JSON text or structured-clone values. */
  export type Encoding = 'json' | 'native'

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
 * `cloudflare:workers` import, so it bundles anywhere; for Workers RPC, extend
 * {@link DurableObjectStore.rpc} instead.
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
  /** The object's state (`ctx`), for subclasses that use its storage or alarms. */
  protected state: DurableObjectStore.State
  /** The Worker's bindings, for subclasses. */
  protected env: unknown
  /**
   * The object's storage: a subclass schedules alarms with it from {@link DurableObjectStore.onWrite}.
   * A plain field, like `state` and `env`, so subclasses that assign `this.storage = state.storage` keep working.
   */
  protected storage: DurableObjectStore.Storage

  constructor(state: DurableObjectStore.State, env?: unknown) {
    this.state = state
    this.env = env
    this.storage = state.storage
  }

  /**
   * Returns this class rebuilt on `base`, the `DurableObject` class from
   * `cloudflare:workers`: Workers RPC calls only reach classes that extend it,
   * and taking it as an argument keeps this module free of that import. Called
   * on a subclass, it keeps the subclass's methods (such as `onWrite` and
   * `alarm`), but not its constructor, field initializers or `#private` members,
   * which the copied methods cannot reach: subclass the returned class, or set
   * state up lazily in ordinary members.
   *
   * @example
   * ```ts
   * import { DurableObject } from 'cloudflare:workers'
   *
   * export class MppxStore extends Store.DurableObjectStore.rpc(DurableObject) {}
   * ```
   */
  static rpc<store extends typeof DurableObjectStore>(
    this: store,
    base: abstract new (state: any, env: any) => object,
  ): store {
    class RpcStore extends (base as new (state: unknown, env: unknown) => object) {
      constructor(state: DurableObjectStore.State, env?: unknown) {
        super(state, env)
        Object.assign(this, { env, state, storage: state.storage })
      }
    }
    // Copy the receiver's prototype chain down to DurableObjectStore, most-derived last so it wins.
    const chain: object[] = []
    for (let proto: object = this.prototype; ; proto = Object.getPrototypeOf(proto)) {
      chain.unshift(proto)
      if (proto === DurableObjectStore.prototype) break
    }
    for (const proto of chain)
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto)))
        if (name !== 'constructor') Object.defineProperty(RpcStore.prototype, name, descriptor)
    return RpcStore as unknown as store
  }

  /**
   * Called for every applied put, delete, swap and claim (except claims in replay shards,
   * which live in the shard's own table), after the storage write and before the
   * response, with the decoded values (`null` when the key is absent). When the
   * storage has `transaction()`, the write and this hook run in one transaction,
   * passed as `storage`: make the hook's writes and alarms
   * through it so they commit with the store's write, and throw to roll the
   * write back. Make only storage calls and alarms here: awaiting other I/O
   * (`fetch`, a queue send) opens the object's input gate before the write
   * commits, so a concurrent swap or claim could act on the old value. Do that
   * work from {@link DurableObjectStore.alarm} instead. Does nothing by default.
   */
  protected onWrite(
    _key: string,
    _previous: unknown | null,
    _next: unknown | null,
    _storage: DurableObjectStore.Storage,
  ): void | Promise<void> {}

  /**
   * Handles the object's alarm, which a subclass sets through
   * {@link DurableObjectStore.storage}. In a replay shard it clears expired claims, so
   * a subclass that overrides it must call `super.alarm()`, or expired claims stay stored.
   * Elsewhere, including on key-value-backed objects, it does nothing.
   */
  async alarm(): Promise<void> {
    const { sql } = this.state.storage
    if (!sql) return
    let shard: unknown[]
    try {
      shard = sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mppx_replay_claims'")
        .toArray()
    } catch {
      // A key-value-backed object has `sql` but cannot run it, so it holds no replay shard.
      return
    }
    if (shard.length === 0) return
    const now = Date.now()
    sql.exec('DELETE FROM mppx_replay_claims WHERE expires <= ?', now)
    const [{ expires } = {}] = sql
      .exec('SELECT MIN(expires) AS expires FROM mppx_replay_claims')
      .toArray()
    if (typeof expires === 'number') await this.state.storage.setAlarm?.(Math.max(expires, now + 1))
  }

  /**
   * Claims `key` until `expires` in this replay shard, unless it holds an
   * unexpired claim: one `INSERT … ON CONFLICT DO UPDATE … WHERE` statement, so
   * concurrent claims have exactly one winner. Schedules the alarm that clears it.
   */
  async claimReplay(key: string, expires: number): Promise<boolean> {
    const sql = this.replayClaims()
    const now = Date.now()
    if (!Number.isFinite(expires) || expires <= now) return false
    const claimed =
      sql
        .exec(
          'INSERT INTO mppx_replay_claims (key, expires) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET expires = excluded.expires WHERE mppx_replay_claims.expires <= ? RETURNING key',
          key,
          expires,
          now,
        )
        .toArray().length === 1
    if (claimed) {
      const { storage } = this.state
      try {
        const alarm = (await storage.getAlarm?.()) ?? null
        if (alarm === null || expires < alarm)
          await storage.setAlarm?.(Math.max(expires, Date.now() + 1))
      } catch (error) {
        // Without the alarm that clears it the claim must not stay: release it so a retry can claim.
        sql.exec('DELETE FROM mppx_replay_claims WHERE key = ? AND expires = ?', key, expires)
        throw error
      }
    }
    return claimed
  }

  /** Releases `key`'s claim in this replay shard, if it has one. */
  async releaseReplay(key: string): Promise<void> {
    this.replayClaims().exec('DELETE FROM mppx_replay_claims WHERE key = ?', key)
  }

  /** Reads a key: its JSON text, or its stored value with `native` encoding. */
  async get(key: string, _encoding: durableObject.Encoding = 'json'): Promise<unknown> {
    return (await this.state.storage.get(key)) ?? null
  }

  /** Writes a key: JSON text, or any structured-clone value with `native` encoding. */
  async put(key: string, value: unknown, encoding: durableObject.Encoding = 'json'): Promise<void> {
    await this.commit(key, value, encoding)
  }

  /** Deletes a key. */
  async delete(key: string, encoding: durableObject.Encoding = 'json'): Promise<void> {
    await this.commit(key, null, encoding)
  }

  /**
   * Writes `value` (or deletes, for `null`) only if the key holds `expected`:
   * the same JSON text, or with `native` encoding a structurally equal value.
   * It reads and writes without awaiting other I/O in between, so the object's
   * input gate makes it atomic.
   */
  async swap(
    key: string,
    expected: unknown,
    value: unknown,
    encoding: durableObject.Encoding = 'json',
  ): Promise<DurableObjectStore.SwapResult<unknown>> {
    const current = await this.get(key)
    if (encoding === 'native' ? !deepEqual(current, expected ?? null) : current !== expected)
      return { applied: false, current }
    await this.commit(key, value, encoding, current)
    return { applied: true }
  }

  /** Records a replay marker until `expires` unless the key holds a value or an unexpired marker. */
  async claim(
    key: string,
    expires: number,
    encoding: durableObject.Encoding = 'json',
  ): Promise<boolean> {
    if (!Number.isFinite(expires) || expires <= Date.now()) return false
    const raw = await this.get(key)
    const current = decode(raw, encoding)
    if (current !== null && (!isReplayMarker(current) || current.expires > Date.now())) return false
    const marker = { expires, type: 'mppx:replay' } satisfies ReplayMarker
    await this.commit(key, encoding === 'native' ? marker : Json.stringify(marker), encoding, raw)
    return true
  }

  /** Handles one store operation sent by `fetch`, as JSON text. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const body = (await request.json()) as DurableObjectStore.Request
    switch (body.op) {
      case 'get':
        return Response.json(await this.get(body.key))
      case 'put':
        await this.put(body.key, body.value)
        return Response.json(true)
      case 'delete':
        await this.delete(body.key)
        return Response.json(true)
      case 'swap':
        return Response.json(await this.swap(body.key, body.expected, body.value))
      case 'claim':
        return Response.json(await this.claim(body.key, body.expires))
      case 'claimReplay':
        return Response.json(await this.claimReplay(body.key, body.expires))
      case 'releaseReplay':
        await this.releaseReplay(body.key)
        return Response.json(true)
      default:
        return new Response('Unknown operation', { status: 400 })
    }
  }

  /** The replay shard's claims table, created on first use. */
  private replayClaims(): DurableObjectStore.Sql {
    const { sql } = this.state.storage
    if (!sql)
      throw new Error(
        'Store.durableObject: `replayShards` needs a SQLite-backed Durable Object (a `new_sqlite_classes` migration).',
      )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS mppx_replay_claims (key TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
    )
    sql.exec(
      'CREATE INDEX IF NOT EXISTS mppx_replay_claims_by_expiry ON mppx_replay_claims (expires)',
    )
    return sql
  }

  /** Writes or deletes (`null`) a key and runs {@link DurableObjectStore.onWrite}. `previous` is the value the caller already read, if any. */
  private async commit(
    key: string,
    value: unknown,
    encoding: durableObject.Encoding,
    previous?: unknown,
  ): Promise<void> {
    const storage = this.state.storage
    if (this.onWrite === DurableObjectStore.prototype.onWrite) {
      if (value === null) await storage.delete(key)
      else await storage.put(key, value)
      return
    }
    // One transaction: the hook's writes commit with this one, and its failure rolls it back.
    const write = async (target: DurableObjectStore.Storage) => {
      const before = previous === undefined ? ((await target.get(key)) ?? null) : previous
      if (value === null) await target.delete(key)
      else await target.put(key, value)
      await this.onWrite(key, decode(before, encoding), decode(value, encoding), target)
    }
    if (storage.transaction) await storage.transaction(write)
    else await write(storage)
  }
}

/** A stored value as the store sees it: JSON text parsed, a native value as is. */
function decode(raw: unknown, encoding: durableObject.Encoding): unknown {
  if (raw == null) return null
  return encoding === 'native' ? raw : Json.parse(raw as string)
}

export declare namespace DurableObjectStore {
  /** The subset of `DurableObjectState` the store uses. */
  export type State = { storage: Storage }

  /** The subset of `DurableObjectStorage` the store uses. */
  export type Storage = {
    get: (key: string) => Promise<unknown>
    put(key: string, value: unknown): Promise<void>
    delete: (key: string) => Promise<unknown>
    /** The scheduled alarm time in milliseconds, or `null`. */
    getAlarm?: (() => Promise<number | null>) | undefined
    /** Schedules the object's alarm, replacing any earlier one. */
    setAlarm?: ((scheduledTime: number | Date) => Promise<void>) | undefined
    /** Cancels the object's alarm. */
    deleteAlarm?: (() => Promise<void>) | undefined
    /** Runs `closure` in a transaction that rolls back when it throws. */
    transaction?<result>(closure: (txn: Storage) => Promise<result>): Promise<result>
    /** The object's SQLite database, on SQLite-backed objects: replay shards need it. */
    sql?: Sql | undefined
  }

  /** The subset of `SqlStorage` replay shards use. */
  export type Sql = {
    exec: (query: string, ...bindings: unknown[]) => { toArray: () => Record<string, unknown>[] }
  }

  /** A replay shard's methods that {@link durableObject} calls over Workers RPC. */
  export type ReplayShard = {
    claimReplay: (key: string, expires: number) => Promise<boolean>
    releaseReplay: (key: string) => Promise<unknown>
  }

  /** Result of a compare-and-swap: on a conflict, the stored value, so a retry needs no read. */
  export type SwapResult<value = string | null> =
    | { applied: true }
    | { applied: false; current: value }

  /** The object's methods that {@link durableObject} calls, positionally, over Workers RPC. */
  export type Stub = {
    get: (key: string, encoding?: durableObject.Encoding) => Promise<unknown>
    put: (key: string, value: unknown, encoding?: durableObject.Encoding) => Promise<unknown>
    delete: (key: string, encoding?: durableObject.Encoding) => Promise<unknown>
    swap: (
      key: string,
      expected: unknown,
      value: unknown,
      encoding?: durableObject.Encoding,
    ) => Promise<SwapResult<unknown>>
    claim: (key: string, expires: number, encoding?: durableObject.Encoding) => Promise<boolean>
  }

  /** An operation sent from {@link durableObject} to the object. */
  export type Request =
    | { op: 'get'; key: string }
    | { op: 'put'; key: string; value: string }
    | { op: 'delete'; key: string }
    | { op: 'swap'; key: string; expected: string | null; value: string | null }
    | { op: 'claim'; key: string; expires: number }
    | { op: 'claimReplay'; key: string; expires: number }
    | { op: 'releaseReplay'; key: string }
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
        // `expires` mirrors a replay marker's expiry, so a claim needs no JSON in SQL.
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires DOUBLE PRECISION)`,
        [],
      ),
    ).then(
      () => {},
      async (error) => {
        // Concurrent `CREATE TABLE IF NOT EXISTS` from other processes can fail on
        // Postgres (duplicate catalog row) although the table now exists: probe it.
        const exists = await Promise.resolve(
          driver.query(`SELECT 1 FROM ${table} WHERE 1 = 0`, []),
        ).then(
          () => true,
          () => false,
        )
        if (exists) return
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

  /** The `expires` column for a serialized value: the expiry of a replay marker, else null. */
  const expiresOf = (raw: string) => {
    const value = Json.parse(raw)
    return isReplayMarker(value) ? value.expires : null
  }

  /** Writes `value` (or deletes, for `null`) only if the key still holds `expected`. */
  async function swap(key: string, expected: string | null, value: string | null) {
    let rows: sql.Row[]
    if (expected === null) {
      if (value === null) return { applied: true }
      rows = await query(
        `INSERT INTO ${table} (key, value, expires) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, value, expiresOf(value)],
      )
    } else if (value === null)
      rows = await query(`DELETE FROM ${table} WHERE key = ? AND value = ? RETURNING key`, [
        key,
        expected,
      ])
    else
      rows = await query(
        `UPDATE ${table} SET value = ?, expires = ? WHERE key = ? AND value = ? RETURNING key`,
        [value, expiresOf(value), key, expected],
      )
    return { applied: rows.length > 0 }
  }

  return from(
    {
      async get(key: string) {
        const raw = await read(key)
        if (raw == null) return null as any
        return Json.parse(raw)
      },
      async put(key: string, value: unknown) {
        const raw = Json.stringify(value)
        await query(
          `INSERT INTO ${table} (key, value, expires) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires = excluded.expires`,
          [key, raw, expiresOf(raw)],
        )
      },
      async delete(key: string) {
        await query(`DELETE FROM ${table} WHERE key = ?`, [key])
      },
      update<result>(key: string, fn: (current: unknown | null) => Change<unknown, result>) {
        return compareAndSwap({
          fn,
          key,
          label: 'SQL store',
          maxAttempts,
          read: () => read(key),
          swap: (expected, value) => swap(key, expected, value),
        })
      },
      // One statement: insert the marker, or replace one whose expiry has passed.
      async tryClaim(key: string, expires: number) {
        if (!Number.isFinite(expires) || expires <= Date.now()) return false
        const rows = await query(
          `INSERT INTO ${table} AS existing (key, value, expires) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires = excluded.expires WHERE existing.expires IS NOT NULL AND existing.expires <= ? RETURNING key`,
          [
            key,
            Json.stringify({ expires, type: 'mppx:replay' } satisfies ReplayMarker),
            expires,
            Date.now(),
          ],
        )
        // The claim's own expiry may have passed while the statement ran.
        return rows.length > 0 && expires > Date.now()
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
 * `better-sqlite3` or `bun:sqlite`. See {@link sql}. For libSQL or Turso, use
 * {@link sql} with dialect `sqlite` and return the result set's rows:
 * `Store.sql({ dialect: 'sqlite', query: async (sql, args) => (await client.execute({ sql, args: args as InArgs })).rows })`.
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
        const statement = database.prepare(text)
        // better-sqlite3 allows all() only on statements that return rows.
        if (statement.reader === false && statement.run) {
          await statement.run(...params)
          return []
        }
        return (await statement.all(...params)) as sql.Row[]
      },
    },
    options,
  )
}

export declare namespace sqlite {
  /** A database whose prepared statements run with `all(...params)`, or `run(...params)` when better-sqlite3 marks them as returning no rows. */
  export type Database = {
    prepare: (sql: string) => {
      all: (...params: any[]) => unknown
      run?: ((...params: any[]) => unknown) | undefined
      /** better-sqlite3: whether the statement returns rows. */
      reader?: boolean | undefined
    }
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
