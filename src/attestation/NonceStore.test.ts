import * as Attestation from 'mppx/attestation'
import { expect, test } from 'vp/test'

test('atomically consumes a nonce once', async () => {
  const store = Attestation.NonceStore.memory()
  const results = await Promise.all([
    store.consume('tap:key:nonce', Date.now() + 60_000),
    store.consume('tap:key:nonce', Date.now() + 60_000),
  ])

  expect(results.sort()).toEqual([false, true])
})

test('allows an expired nonce to be consumed again', () => {
  const store = Attestation.NonceStore.memory()

  expect(store.consume('tap:key:nonce', Date.now() - 1)).toBe(false)
  expect(store.consume('tap:key:nonce', Date.now() + 60_000)).toBe(false)
})
