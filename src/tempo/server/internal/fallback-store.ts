import { warnOnce } from '../../../internal/warnOnce.js'
import * as Store from '../../../Store.js'

/**
 * Creates the in-memory store used when a Tempo server method is configured without `store`.
 *
 * Replay protection backed by this store only covers the current instance, so this warns once
 * per `method` per process.
 */
export function fallbackStore(method: string): Store.AtomicStore {
  warnOnce(
    `memory-store:${method}`,
    `${method}() has no \`store\` configured and is using an in-memory store. Replay protection and payment state are scoped to this instance, so a credential accepted by one replica, serverless isolate, or per-request \`Mppx\` instance can be accepted again by another. Pass a shared atomic store (e.g. \`Store.redis()\`, \`Store.upstash()\`, or \`Store.cloudflare()\` with \`update\`) when running more than one instance.`,
  )
  return Store.memory()
}
