import { Method, z } from 'mppx'
import { describe, expect, expectTypeOf, test } from 'vp/test'

describe('from', () => {
  test('behavior: creates intent', () => {
    const method = Method.from({
      name: 'tempo',
      intent: 'charge',
      schema: {
        credential: {
          payload: z.object({
            signature: z.string(),
          }),
        },
        request: z.object({
          amount: z.string(),
          currency: z.string(),
        }),
      },
    })

    expect(method.intent).toBe('charge')
    expect(method.name).toBe('tempo')
    expect(method.schema.request).toBeDefined()
    expect(method.schema.credential.payload).toBeDefined()
  })

  test('types: intent literal is inferred', () => {
    const method = Method.from({
      name: 'tempo',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ sig: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })

    expectTypeOf(method.intent).toEqualTypeOf<'charge'>()
  })

  test('types: name literal is inferred', () => {
    const method = Method.from({
      name: 'tempo',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ sig: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })

    expectTypeOf(method.name).toEqualTypeOf<'tempo'>()
  })

  test('types: schema types are preserved', () => {
    const requestSchema = z.object({
      amount: z.string(),
      currency: z.string(),
    })
    const payloadSchema = z.object({
      signature: z.string(),
      type: z.literal('transaction'),
    })

    const method = Method.from({
      name: 'tempo',
      intent: 'charge',
      schema: {
        credential: { payload: payloadSchema },
        request: requestSchema,
      },
    })

    expectTypeOf(method.schema.request).toEqualTypeOf(requestSchema)
    expectTypeOf(method.schema.credential.payload).toEqualTypeOf(payloadSchema)
  })
})

describe('PinnedRequestBinding', () => {
  test('from: separates core and method-specific bindings into readonly objects', () => {
    const binding = Method.PinnedRequestBinding.from({
      amount: 1000,
      currency: '0xABCD',
      recipient: '0xEf01',
      methodDetails: {
        chainId: 10,
        memo: '0xABCD',
      },
    })

    expect(binding).toEqual({
      coreBinding: {
        amount: '1000',
        currency: '0xABCD',
        recipient: '0xEf01',
      },
      methodBinding: {
        chainId: '10',
        memo: '0xabcd',
      },
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.coreBinding)).toBe(true)
    expect(Object.isFrozen(binding.methodBinding)).toBe(true)
  })

  test('from: deeply freezes comparable splits data', () => {
    const binding = Method.PinnedRequestBinding.from({
      methodDetails: {
        splits: [
          {
            recipient: '0xBEEF',
            amount: '2',
            enabled: true,
            ratio: 2,
            note: null,
          },
        ],
      },
    })

    expect(binding).toEqual({
      coreBinding: {},
      methodBinding: {
        splits: [
          {
            amount: '2',
            enabled: true,
            note: null,
            recipient: '0xbeef',
            ratio: 2,
          },
        ],
      },
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.coreBinding)).toBe(true)
    expect(Object.isFrozen(binding.methodBinding)).toBe(true)
    expect(Object.isFrozen(binding.methodBinding.splits as object)).toBe(true)
    expect(
      Object.isFrozen((binding.methodBinding.splits as Array<Record<string, unknown>>)[0]!),
    ).toBe(true)
  })
})
