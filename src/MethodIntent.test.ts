import { Intent, MethodIntent, z } from 'mpay'
import { describe, expect, expectTypeOf, test } from 'vitest'

describe('from', () => {
  test('behavior: creates intent', () => {
    const intent = MethodIntent.from({
      method: 'tempo',
      name: 'charge',
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

    expect(intent.name).toBe('charge')
    expect(intent.method).toBe('tempo')
    expect(intent.schema.request).toBeDefined()
    expect(intent.schema.credential.payload).toBeDefined()
  })

  test('types: name literal is inferred', () => {
    const intent = MethodIntent.from({
      method: 'tempo',
      name: 'charge',
      schema: {
        credential: { payload: z.object({ sig: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })

    expectTypeOf(intent.name).toEqualTypeOf<'charge'>()
  })

  test('types: method literal is inferred', () => {
    const intent = MethodIntent.from({
      method: 'tempo',
      name: 'charge',
      schema: {
        credential: { payload: z.object({ sig: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })

    expectTypeOf(intent.method).toEqualTypeOf<'tempo'>()
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

    const intent = MethodIntent.from({
      method: 'tempo',
      name: 'charge',
      schema: {
        credential: { payload: payloadSchema },
        request: requestSchema,
      },
    })

    expectTypeOf(intent.schema.request).toEqualTypeOf(requestSchema)
    expectTypeOf(intent.schema.credential.payload).toEqualTypeOf(payloadSchema)
  })
})

describe('fromIntent', () => {
  test('behavior: creates method intent from base intent', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          recipient: z.optional(z.string()),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: {
          payload: z.object({
            signature: z.string(),
            type: z.literal('transaction'),
          }),
        },
        request: {
          methodDetails: z.object({
            chainId: z.number(),
          }),
          requires: ['recipient'],
        },
      },
    })

    expect(tempoCharge.name).toBe('charge')
    expect(tempoCharge.method).toBe('tempo')
    expect(tempoCharge.schema.request).toBeDefined()
    expect(tempoCharge.schema.credential.payload).toBeDefined()
  })

  test('types: name and method literals are inferred', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          currency: z.string(),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: {
          payload: z.object({ signature: z.string() }),
        },
        request: {
          methodDetails: z.object({}),
          requires: [],
        },
      },
    })

    expectTypeOf(tempoCharge.name).toEqualTypeOf<'charge'>()
    expectTypeOf(tempoCharge.method).toEqualTypeOf<'tempo'>()
  })

  test('types: request output has methodDetails nested', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          currency: z.string(),
          recipient: z.optional(z.string()),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: { payload: z.object({}) },
        request: {
          methodDetails: z.object({
            chainId: z.number(),
          }),
          requires: [],
        },
      },
    })

    type Input = z.input<typeof tempoCharge.schema.request>
    expectTypeOf<Input>().toExtend<{
      amount: string
      chainId: number
      currency: string
    }>()

    type Output = z.output<typeof tempoCharge.schema.request>
    expectTypeOf<Output>().toExtend<{
      amount: string
      currency: string
      methodDetails?: { chainId: number }
    }>()
  })

  test('types: requires makes optional fields required in output type', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          recipient: z.optional(z.string()),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: { payload: z.object({}) },
        request: {
          methodDetails: z.object({}),
          requires: ['recipient'],
        },
      },
    })

    type Request = z.infer<typeof tempoCharge.schema.request>
    expectTypeOf<Request>().toMatchTypeOf<{ amount: string; recipient: string }>()
  })

  test('behavior: request schema includes base intent fields', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          currency: z.string(),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: { payload: z.object({}) },
        request: {
          methodDetails: z.object({}),
          requires: [],
        },
      },
    })

    const result = tempoCharge.schema.request.safeParse({
      amount: '100',
      currency: 'USD',
    })
    expect(result.success).toBe(true)
  })

  test('behavior: request schema includes methodDetails fields', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: { payload: z.object({}) },
        request: {
          methodDetails: z.object({
            chainId: z.number(),
            recipient: z.string(),
          }),
          requires: [],
        },
      },
    })

    const result = tempoCharge.schema.request.safeParse({
      amount: '100',
      chainId: 42431,
      recipient: '0x123',
    })
    expect(result.success).toBe(true)
  })

  test('behavior: requires makes optional fields required', () => {
    const charge = Intent.from({
      name: 'charge',
      schema: {
        request: z.object({
          amount: z.string(),
          recipient: z.optional(z.string()),
        }),
      },
    })

    const tempoCharge = MethodIntent.fromIntent(charge, {
      method: 'tempo',
      schema: {
        credential: { payload: z.object({}) },
        request: {
          methodDetails: z.object({}),
          requires: ['recipient'],
        },
      },
    })

    const withRecipient = tempoCharge.schema.request.safeParse({
      amount: '100',
      recipient: '0x123',
    })
    expect(withRecipient.success).toBe(true)

    const withoutRecipient = tempoCharge.schema.request.safeParse({
      amount: '100',
    })
    expect(withoutRecipient.success).toBe(false)
  })
})
