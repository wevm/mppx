import type { MaybePromise } from '../internal/types.js'

/** Atomically records signature nonces for replay protection. */
export type Store = {
  /**
   * Records a nonce key and returns `true` when it was already unexpired.
   * `expires` is its Unix expiration timestamp in milliseconds.
   */
  consume: (key: string, expires: number) => MaybePromise<boolean>
}

/**
 * Creates a process-local nonce store.
 *
 * Use this only when every request reaches one long-lived server process. Multi-instance
 * deployments must supply a shared store backed by an atomic insert-if-absent operation.
 */
export function memory(): Store {
  const values = new Map<string, number>()
  return {
    consume(key, expires) {
      const now = Date.now()
      for (const [value, expiration] of values) if (expiration <= now) values.delete(value)
      if (values.has(key)) return true
      values.set(key, expires)
      return false
    },
  }
}
