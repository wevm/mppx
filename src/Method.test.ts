import { Challenge, Credential, Method, z } from 'mppx'
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

describe('credential execution', () => {
  const base = Method.from({
    name: 'alpha',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string() }),
    },
  })

  function credential() {
    return Credential.from({
      challenge: Challenge.from({
        id: 'challenge-id',
        expires: new Date(Date.now() + 60_000).toISOString(),
        intent: 'charge',
        method: 'alpha',
        realm: 'example.com',
        request: { amount: '1000' },
      }),
      payload: { token: 'valid' },
    })
  }

  test('types: requires broadcast with validate', () => {
    // @ts-expect-error Split validation requires a terminal broadcast hook.
    Method.toServer(base, {
      validate: async () => ({}) as never,
      verify: async () => ({}) as never,
    })
  })

  test('types: excludes verify with broadcast', () => {
    // @ts-expect-error A broadcast hook replaces the legacy verify hook.
    Method.toServer(base, {
      broadcast: async () => ({}) as never,
      verify: async () => ({}) as never,
    })
  })

  test('validates without broadcasting', async () => {
    const calls: string[] = []
    const method = Method.toServer(base, {
      async validate({ credential, request }) {
        calls.push('validate')
        return {
          challenge: credential.challenge,
          credential,
          details: {},
          intent: 'charge',
          method: 'alpha',
          request,
        }
      },
      async broadcast() {
        calls.push('broadcast')
        return {
          method: 'alpha',
          reference: 'reference',
          status: 'success',
          timestamp: new Date().toISOString(),
        }
      },
    })

    await Method.validateCredential([method], credential())

    expect(calls).toEqual(['validate'])
  })

  test('revalidates before broadcasting', async () => {
    const calls: string[] = []
    const method = Method.toServer(base, {
      async validate({ credential, request }) {
        calls.push('validate')
        return {
          challenge: credential.challenge,
          credential,
          details: {},
          intent: 'charge',
          method: 'alpha',
          request,
        }
      },
      async broadcast() {
        calls.push('broadcast')
        return {
          method: 'alpha',
          reference: 'reference',
          status: 'success',
          timestamp: new Date().toISOString(),
        }
      },
    })

    await Method.broadcastCredential([method], credential())

    expect(calls).toEqual(['validate', 'broadcast'])
  })
})
