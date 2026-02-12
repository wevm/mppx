/**
 * Async key-value store interface.
 *
 * Modeled after Cloudflare KV's API (`get`/`put`/`delete`).
 * Implementations handle serialization internally.
 */
import { Json } from 'ox'

export type Store = {
  get: <value = unknown>(key: string) => Promise<value | null>
  put: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
}

/** Creates a {@link Store} from an existing implementation. */
export function from<store extends Store>(store: store): store {
  return store
}

/** Wraps a Cloudflare KV namespace. */
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
  })
}

export declare namespace cloudflare {
  export type Parameters = {
    get: (key: string) => Promise<unknown>
    put: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<void>
  }
}

/** In-memory store backed by a `Map`. JSON-roundtrips values to match production behavior. */
export function memory(): Store {
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
  })
}

/** Wraps an Upstash Redis instance (e.g. Vercel KV). */
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
  })
}

export declare namespace upstash {
  export type Parameters = {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<unknown>
    del: (key: string) => Promise<unknown>
  }
}
