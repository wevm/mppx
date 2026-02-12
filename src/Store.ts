/**
 * Async key-value store interface.
 *
 * Modeled after Cloudflare KV's API (`get`/`put`/`delete`).
 * Implementations handle serialization internally.
 */
export type Store = {
  get: <value = unknown>(key: string) => Promise<value>
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
      return (await kv.get(key)) as any
    },
    async put(key, value) {
      await kv.put(key, JSON.stringify(value))
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

/** In-memory store backed by a `Map`. Useful for development and testing. */
export function memory(): Store {
  const store = new Map<string, unknown>()
  return from({
    async get(key) {
      return (store.get(key) ?? null) as any
    },
    async put(key, value) {
      store.set(key, value)
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
