import { expectTypeOf, test } from 'vp/test'

import * as Store from './Store.js'

test('default Store accepts any string key', () => {
  const store = {} as Store.Store
  expectTypeOf(store.get).parameter(0).toBeString()
  expectTypeOf(store.put).parameter(0).toBeString()
  expectTypeOf(store.delete).parameter(0).toBeString()
  expectTypeOf(store.update).parameter(0).toBeString()
})

test('default Store get returns unknown', async () => {
  const store = {} as Store.Store
  const value = await store.get('anything')
  expectTypeOf(value).toEqualTypeOf<unknown>()
})

test('memory returns AtomicStore', () => {
  const store = Store.memory()
  expectTypeOf(store).toEqualTypeOf<Store.AtomicStore>()
})

test('typed Store constrains keys', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  expectTypeOf(store.get).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
  expectTypeOf(store.put).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
  expectTypeOf(store.delete).parameter(0).toEqualTypeOf<`mppx:charge:${string}`>()
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

test('typed Store update infers value and result types', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  const result = store.update!('mppx:charge:0x123', (current) => {
    if (current === null) return { op: 'set', value: 1, result: 'inserted' as const }
    return { op: 'noop', result: 'existing' as const }
  })

  expectTypeOf(result).toEqualTypeOf<Promise<'inserted' | 'existing'>>()
})

test('typed Store update enforces set value type', () => {
  type ItemMap = { [key: `mppx:charge:${string}`]: number }
  const store = {} as Store.Store<ItemMap>

  // @ts-expect-error — update set value must be number, not string
  store.update!('mppx:charge:0x123', (_current) => ({ op: 'set', value: 'wrong', result: true }))
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
