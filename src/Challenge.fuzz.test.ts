import * as fc from 'fast-check'
import { Challenge } from 'mppx'
import { describe, expect, test } from 'vitest'

describe('parseAuthParams robustness', () => {
  test('fuzz: deserialize never throws unhandled exception on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          Challenge.deserialize(input)
        } catch (e) {
          if (!(e instanceof Error)) throw e
          if (e instanceof TypeError || e instanceof RangeError) throw e
        }
      }),
      { numRuns: 10_000 },
    )
  })
})

describe('adversarial header strings', () => {
  const adversarialHeader = fc.oneof(
    // Deeply nested quotes
    fc.string().map((s) => `Payment ${s}`),
    // Unterminated quotes
    fc.string().map((s) => `Payment id="${s}`),
    // Escaped characters at boundary
    fc.string().map((s) => `Payment id="\\${s}"`),
    // Many commas
    fc.nat({ max: 100 }).map((n) => `Payment ${',,,,'.repeat(n)}`),
    // Very long keys
    fc
      .string({ minLength: 1000, maxLength: 5000 })
      .map((s) => `Payment ${s.replace(/[^a-z]/g, 'a')}="val"`),
    // NUL and control characters
    fc
      .uint8Array({ minLength: 1, maxLength: 200 })
      .map((arr) => `Payment id="${String.fromCharCode(...arr)}"`),
  )

  test('fuzz: adversarial headers never cause unhandled exceptions', () => {
    fc.assert(
      fc.property(adversarialHeader, (input) => {
        try {
          Challenge.deserialize(input)
        } catch (e) {
          if (!(e instanceof Error)) throw e
          if (e instanceof TypeError || e instanceof RangeError) throw e
        }
      }),
      { numRuns: 10_000 },
    )
  })
})

describe('serialize/deserialize roundtrip', () => {
  const challengeArb = fc.record({
    id: fc.string({ minLength: 1 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
    realm: fc.string({ minLength: 1 }).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
    method: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9:_-]*$/.test(s)),
    intent: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s)),
    request: fc.dictionary(
      fc
        .string({ minLength: 1 })
        .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== '__proto__'),
      fc.oneof(fc.string(), fc.integer().map(String), fc.boolean().map(String)),
    ),
  })

  test('fuzz: serialize then deserialize produces equivalent challenge', () => {
    fc.assert(
      fc.property(challengeArb, (input) => {
        const serialized = Challenge.serialize(input as Challenge.Challenge)
        const deserialized = Challenge.deserialize(serialized)

        expect(deserialized.id).toBe(input.id)
        expect(deserialized.realm).toBe(input.realm)
        expect(deserialized.method).toBe(input.method)
        expect(deserialized.intent).toBe(input.intent)
        expect(deserialized.request).toEqual(input.request)
      }),
      { numRuns: 1_000 },
    )
  })
})

describe('deserializeList roundtrip', () => {
  const challengeArb = fc.record({
    id: fc.string({ minLength: 1 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
    realm: fc.string({ minLength: 1 }).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
    method: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9:_-]*$/.test(s)),
    intent: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s)),
    request: fc.dictionary(
      fc
        .string({ minLength: 1 })
        .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== '__proto__'),
      fc.oneof(fc.string(), fc.integer().map(String), fc.boolean().map(String)),
    ),
  })

  test('fuzz: serialize multiple then deserializeList returns all challenges', () => {
    fc.assert(
      fc.property(fc.array(challengeArb, { minLength: 1, maxLength: 3 }), (challenges) => {
        const header = challenges
          .map((c) => Challenge.serialize(c as Challenge.Challenge))
          .join(', ')
        const result = Challenge.deserializeList(header)

        expect(result).toHaveLength(challenges.length)
        for (let i = 0; i < challenges.length; i++) {
          expect(result[i]!.id).toBe(challenges[i]!.id)
          expect(result[i]!.realm).toBe(challenges[i]!.realm)
          expect(result[i]!.method).toBe(challenges[i]!.method)
          expect(result[i]!.intent).toBe(challenges[i]!.intent)
          expect(result[i]!.request).toEqual(challenges[i]!.request)
        }
      }),
      { numRuns: 1_000 },
    )
  })
})
