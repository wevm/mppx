import type { Hex } from 'viem'

import type * as Store from '../../Store.js'
import type { Authorization, Receipt } from './Types.js'

export const defaultKeyPrefix = 'tempo:authorize:'

export type StoreItemMap<keyPrefix extends string = typeof defaultKeyPrefix> = Record<
  `${keyPrefix}${string}`,
  Authorization
>

/** Store wrapper for Tempo authorize records. */
export type AuthorizationStore = {
  readonly keyPrefix: string
  create(authorization: Authorization): Promise<'created' | 'exists'>
  get(id: Hex): Promise<Authorization | null>
  update<result>(
    id: Hex,
    fn: (current: Authorization | null) => Store.Change<Authorization, result>,
  ): Promise<result>
}

/** Wraps a generic atomic store for Tempo authorize state. */
export function fromStore(
  store: Store.AtomicStore,
  options: fromStore.Options = {},
): AuthorizationStore {
  const keyPrefix = options.keyPrefix ?? defaultKeyPrefix
  return {
    keyPrefix,
    async create(authorization) {
      return store.update(toKey(authorization.channel.id, keyPrefix), (current) => {
        if (current) return { op: 'noop', result: 'exists' as const }
        return { op: 'set', value: authorization, result: 'created' as const }
      })
    },
    async get(id) {
      return (await store.get(toKey(id, keyPrefix))) as Authorization | null
    },
    async update(id, fn) {
      return store.update(toKey(id, keyPrefix), (current) =>
        fn((current as Authorization | null) ?? null),
      )
    },
  }
}

export declare namespace fromStore {
  type Options = {
    keyPrefix?: string | undefined
  }
}

export function getCaptureReceipt(
  authorization: Authorization,
  idempotencyKey: string | undefined,
): Receipt | undefined {
  if (!idempotencyKey) return undefined
  return authorization.captureReceipts?.[idempotencyKey]
}

function toKey(id: Hex, keyPrefix: string) {
  return `${keyPrefix}${id.toLowerCase()}` as const
}
