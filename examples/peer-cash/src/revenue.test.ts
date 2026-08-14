import assert from 'node:assert/strict'
import test from 'node:test'

import { RevenueTracker } from './revenue.js'

test('deduplicates settlement references', () => {
  const revenue = new RevenueTracker(10_000_000n)

  assert.equal(revenue.record('0xabc', 6_000_000n), true)
  assert.equal(revenue.record('0xabc', 6_000_000n), false)
  assert.deepEqual(revenue.snapshot(), {
    available: 6_000_000n,
    ready: false,
    reserved: 0n,
    settled: 6_000_000n,
    threshold: 10_000_000n,
  })
})

test('reserves only confirmed, unreserved revenue', () => {
  const revenue = new RevenueTracker(5_000_000n)
  revenue.record('0xabc', 7_000_000n)
  revenue.reserve(5_000_000n)

  assert.equal(revenue.snapshot().available, 2_000_000n)
  assert.throws(() => revenue.reserve(3_000_000n), /exceeds unreserved settlements/)

  revenue.release(5_000_000n)
  assert.equal(revenue.snapshot().available, 7_000_000n)
})
