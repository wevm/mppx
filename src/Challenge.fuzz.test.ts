import * as fc from 'fast-check'
import { Challenge } from 'mppx'
import { describe, expect, test } from 'vp/test'

describe('parseAuthParams robustness', () => {
  test('deserializers never throw unhandled exceptions on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        for (const deserialize of [Challenge.deserialize, Challenge.deserializeList]) {
          try {
            deserialize(input)
          } catch (e) {
            if (!(e instanceof Error)) throw e
            if (e instanceof TypeError || e instanceof RangeError) throw e
          }
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

  test('adversarial headers never cause unhandled exceptions', () => {
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

const authParamTextArb = fc.string().filter((value) => !/[\r\n]/.test(value))
const schemeLikeTextArb = fc
  .tuple(
    authParamTextArb,
    fc.constantFrom('Payment ', 'payment ', 'PAYMENT\t', 'pAyMeNt  '),
    authParamTextArb,
  )
  .map(([prefix, token, suffix]) => `${prefix}${token}${suffix}`)
const quotedFieldTextArb = fc.oneof(
  authParamTextArb.filter((value) => value.length > 0),
  schemeLikeTextArb,
)
const optionalQuotedFieldTextArb = fc.option(quotedFieldTextArb, { nil: undefined })
const challengeArb = fc.record({
  description: optionalQuotedFieldTextArb,
  id: quotedFieldTextArb,
  realm: quotedFieldTextArb,
  method: fc.stringMatching(/^[a-z]{1,16}$/),
  intent: quotedFieldTextArb,
  opaque: optionalQuotedFieldTextArb,
  request: fc.dictionary(
    fc
      .string({ minLength: 1 })
      .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== '__proto__'),
    fc.oneof(fc.string(), fc.integer().map(String), fc.boolean().map(String)),
  ),
})

function escapeAuthParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const decoySchemeArb = fc
  .tuple(fc.constantFrom('Basic', 'Bearer', 'Digest'), schemeLikeTextArb)
  .map(([scheme, value]) => `${scheme} realm="${escapeAuthParam(value)}"`)

describe('serialize/deserialize roundtrip', () => {
  test('serialize then deserialize produces equivalent challenge', () => {
    fc.assert(
      fc.property(challengeArb, (input) => {
        const serialized = Challenge.serialize(input as Challenge.Challenge)
        const deserialized = Challenge.deserialize(serialized)

        expect(deserialized.id).toBe(input.id)
        expect(deserialized.realm).toBe(input.realm)
        expect(deserialized.method).toBe(input.method)
        expect(deserialized.intent).toBe(input.intent)
        expect(deserialized.request).toEqual(input.request)
        expect(deserialized.description).toBe(input.description)
        expect(deserialized.opaque).toBe(input.opaque)
      }),
      { numRuns: 5_000 },
    )
  })
})

describe('deserializeList roundtrip', () => {
  const entryArb = fc.record({
    challenge: challengeArb,
    decoy: fc.option(decoySchemeArb, { nil: undefined }),
    scheme: fc.constantFrom('Payment ', 'payment ', 'PAYMENT  ', 'pAyMeNt\t'),
  })

  test('finds only real challenges among quoted decoys and mixed auth schemes', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { minLength: 1, maxLength: 5 }),
        fc.option(decoySchemeArb, { nil: undefined }),
        (entries, trailingDecoy) => {
          const parts: string[] = []
          for (const { challenge, decoy, scheme } of entries) {
            if (decoy) parts.push(decoy)
            parts.push(
              Challenge.serialize(challenge as Challenge.Challenge).replace(/^Payment /, scheme),
            )
          }
          if (trailingDecoy) parts.push(trailingDecoy)

          const result = Challenge.deserializeList(parts.join(', '))

          expect(result).toHaveLength(entries.length)
          for (let i = 0; i < entries.length; i++) {
            const expected = entries[i]!.challenge
            expect(result[i]!.id).toBe(expected.id)
            expect(result[i]!.realm).toBe(expected.realm)
            expect(result[i]!.method).toBe(expected.method)
            expect(result[i]!.intent).toBe(expected.intent)
            expect(result[i]!.request).toEqual(expected.request)
            expect(result[i]!.description).toBe(expected.description)
            expect(result[i]!.opaque).toBe(expected.opaque)
          }
        },
      ),
      { numRuns: 10_000 },
    )
  })
})
