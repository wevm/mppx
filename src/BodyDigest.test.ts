import { BodyDigest } from 'mpay'
import { describe, expect, test } from 'vitest'

describe('compute', () => {
  test('behavior: computes sha-256 digest from string', () => {
    const digest = BodyDigest.compute('{"amount":"1000"}')
    expect(digest).toMatch(/^sha-256=/)
    expect(digest).toMatchInlineSnapshot(`"sha-256=Bxp4xJtbVfsB9npD5AEWUnIk76Cuv8Au4ECDA+F0biY="`)
  })

  test('behavior: computes sha-256 digest from object', () => {
    const digest = BodyDigest.compute({ amount: '1000' })
    expect(digest).toMatchInlineSnapshot(`"sha-256=Bxp4xJtbVfsB9npD5AEWUnIk76Cuv8Au4ECDA+F0biY="`)
  })

  test('behavior: same input produces same digest', () => {
    const body = '{"foo":"bar"}'
    const digest1 = BodyDigest.compute(body)
    const digest2 = BodyDigest.compute(body)
    expect(digest1).toBe(digest2)
  })

  test('behavior: different inputs produce different digests', () => {
    const digest1 = BodyDigest.compute('{"a":"1"}')
    const digest2 = BodyDigest.compute('{"a":"2"}')
    expect(digest1).not.toBe(digest2)
  })
})

describe('verify', () => {
  test('behavior: returns true for matching digest', () => {
    const body = '{"amount":"1000"}'
    const digest = BodyDigest.compute(body)
    const result = BodyDigest.verify(digest, body)
    expect(result).toBe(true)
  })

  test('behavior: returns false for non-matching digest', () => {
    const digest = BodyDigest.compute('{"amount":"1000"}')
    const result = BodyDigest.verify(digest, '{"amount":"2000"}')
    expect(result).toBe(false)
  })
})
