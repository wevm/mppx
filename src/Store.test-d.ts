import { expectTypeOf, test } from 'vp/test'

import * as Store from './Store.js'

test('default Store accepts any string key', () => {
  const store = {} as Store.Store
  expectTypeOf(store.get).parameter(0).toBeString()
  expectTypeOf(store.put).parameter(0).toBeString()
  expectTypeOf(store.delete).parameter(0).toBeString()
})

test('default Store get returns unknown', async () => {
  const store = {} as Store.Store
  const value = await store.get('anything')
  expectTypeOf(value).toEqualTypeOf<unknown>()
})

test('default AtomicStore accepts any string key on update', () => {
  const store = {} as Store.AtomicStore
  expectTypeOf(store.update).parameter(0).toBeString()
})

test('memory returns AtomicStore', () => {
  const store = Store.memory()
  expectTypeOf(store).toEqualTypeOf<Store.AtomicStore>()
})

test('AtomicStore is assignable to Store', () => {
  const atomic = {} as Store.AtomicStore
  expectTypeOf(atomic).toMatchTypeOf<Store.Store>()
})

test('Store is not assignable to AtomicStore', () => {
  const store = {} as Store.Store
  // @ts-expect-error — Store has no update method
  const _atomic: Store.AtomicStore = store
})

test('typed Store constrains keys', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  expectTypeOf(store.get).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
  expectTypeOf(store.put).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
  expectTypeOf(store.delete).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
})

test('typed AtomicStore constrains keys on update', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.AtomicStore<ItemMap>

  expectTypeOf(store.update).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
})

test('typed Store infers value from key', async () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  const value = await store.get('mppx:charge:0x123')
  expectTypeOf(value).toEqualTypeOf<number | null>()
})

test('typed Store enforces value type on put', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  // @ts-expect-error — value must be number, not string
  store.put('mppx:charge:0x123', 'wrong')
})

test('typed AtomicStore update infers value and result types', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.AtomicStore<ItemMap>

  const result = store.update('mppx:charge:0x123', (current) => {
    if (current === null) return { op: 'set', value: 1, result: 'inserted' as const }
    return { op: 'noop', result: 'existing' as const }
  })

  expectTypeOf(result).toEqualTypeOf<Promise<'inserted' | 'existing'>>()
})

test('typed AtomicStore update enforces set value type', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.AtomicStore<ItemMap>

  // @ts-expect-error — update set value must be number, not string
  store.update('mppx:charge:0x123', (_current) => ({ op: 'set', value: 'wrong', result: true }))
})

test('cloudflare returns generic Store', () => {
  const store = Store.cloudflare({
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  })
  expectTypeOf(store).toEqualTypeOf<Store.Store>()
})

test('upstash returns generic Store', () => {
  const store = Store.upstash({
    get: async () => null,
    set: async () => null,
    del: async () => null,
  })
  expectTypeOf(store).toEqualTypeOf<Store.Store>()
})

test('cloudflare with update returns AtomicStore', () => {
  const store = Store.cloudflare({
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    update: async (_key, fn) => fn(null).result,
  })
  expectTypeOf(store).toEqualTypeOf<Store.AtomicStore>()
})

test('redis with update returns AtomicStore', () => {
  const store = Store.redis({
    get: async () => null,
    set: async () => null,
    del: async () => null,
    update: async (_key, fn) => fn(null).result,
  })
  expectTypeOf(store).toEqualTypeOf<Store.AtomicStore>()
})

test('upstash with update returns AtomicStore', () => {
  const store = Store.upstash({
    get: async () => null,
    set: async () => null,
    del: async () => null,
    update: async (_key, fn) => fn(null).result,
  })
  expectTypeOf(store).toEqualTypeOf<Store.AtomicStore>()
})
