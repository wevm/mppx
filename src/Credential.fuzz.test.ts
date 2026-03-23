import * as fc from 'fast-check'
import { Challenge, Credential, Receipt } from 'mppx'
import { describe, expect, test } from 'vitest'

describe('Credential', () => {
  test('serialize → deserialize roundtrip', () => {
    const credentialArb = fc.record({
      challenge: fc.record({
        id: fc.string({ minLength: 1 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
        realm: fc.string({ minLength: 1 }).filter((s) => /^[^\x00-\x1f]+$/.test(s)),
        method: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9:_-]*$/.test(s)),
        intent: fc.string({ minLength: 1 }).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s)),
        request: fc.constant({ amount: '1000' }),
      }),
      payload: fc.dictionary(
        fc.string({ minLength: 1 }).filter((s) => /^[a-zA-Z_]+$/.test(s)),
        fc.string(),
      ),
    })

    fc.assert(
      fc.property(credentialArb, (input) => {
        const challenge = Challenge.from(input.challenge)
        const credential = Credential.from({ challenge, payload: input.payload })
        const serialized = Credential.serialize(credential)
        const deserialized = Credential.deserialize(serialized)

        expect(deserialized.challenge.id).toBe(challenge.id)
        expect(deserialized.challenge.realm).toBe(challenge.realm)
        expect(deserialized.challenge.method).toBe(challenge.method)
        expect(deserialized.challenge.intent).toBe(challenge.intent)
        expect(deserialized.challenge.request).toEqual(challenge.request)
        expect(deserialized.payload).toEqual(input.payload)
      }),
      { numRuns: 1_000 },
    )
  })
})

describe('Receipt', () => {
  test('serialize → deserialize roundtrip', () => {
    const receiptArb = fc.record({
      method: fc.string({ minLength: 1 }).filter((s) => /^[a-z]+$/.test(s)),
      reference: fc.string({ minLength: 1 }),
      status: fc.constant('success' as const),
      timestamp: fc
        .integer({ min: new Date('2020-01-01').getTime(), max: new Date('2030-01-01').getTime() })
        .map((t) => new Date(t).toISOString()),
    })

    fc.assert(
      fc.property(receiptArb, (input) => {
        const receipt = Receipt.from(input)
        const serialized = Receipt.serialize(receipt)
        const deserialized = Receipt.deserialize(serialized)

        expect(deserialized).toEqual(receipt)
      }),
      { numRuns: 1_000 },
    )
  })
})
