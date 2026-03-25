import { Method, z } from 'mppx'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

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
