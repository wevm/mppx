import * as Env from '../../../internal/env.js'
import { warnOnce } from '../../../internal/warnOnce.js'
import * as Store from '../../../Store.js'

/**
 * Creates the in-memory store used when a Tempo server method is configured without `store`.
 *
 * Replay protection backed by this store only covers the current instance, so a credential
 * accepted by one instance could be accepted again by another. In production or on a
 * multi-instance platform (see {@link Env.sharedRuntime}) this throws instead, so the server fails
 * closed at construction. Elsewhere, such as local development and tests, it warns once per
 * `method` per process and returns a memory store.
 *
 * Pass `store: Store.memory()` explicitly to accept instance-local state anywhere.
 */
export function fallbackStore(method: string): Store.AtomicStore {
  const runtime = Env.sharedRuntime()
  if (runtime)
    throw new Error(
      `${method}() has no \`store\` configured, and ${runtime}, so this server may run as several instances. An in-memory store would let a credential accepted by one instance be accepted again by another. Pass a shared atomic store, such as \`Store.redis()\`, \`Store.upstash()\`, \`Store.postgres()\`, \`Store.sql()\`, \`Store.d1()\`, \`Store.durableObject()\` or \`Store.cloudflare()\` with \`update\`, or pass \`store: Store.memory()\` to accept replay protection scoped to this instance.`,
    )
  warnOnce(
    `memory-store:${method}`,
    `${method}() has no \`store\` configured and is using an in-memory store. Replay protection and payment state are scoped to this instance, so a credential accepted by one replica, serverless isolate, or per-request \`Mppx\` instance can be accepted again by another. Pass a shared atomic store (e.g. \`Store.redis()\`, \`Store.upstash()\`, or \`Store.cloudflare()\` with \`update\`) when running more than one instance. In production this throws; pass \`store: Store.memory()\` explicitly to keep instance-local state.`,
  )
  return Store.memory()
}
