import { stripe } from 'mppx/server'
import { describe, expect, test, vi } from 'vp/test'

import type { AnyServer } from '../../Method.js'
import type { StripeClient } from '../internal/types.js'

function createMockStripeClient(): StripeClient {
  return {
    paymentIntents: {
      create: vi.fn(async () => ({ id: 'pi_mock', status: 'succeeded' })),
    },
    rawRequest: vi.fn(async (_method: string, path: string) => {
      if (path.includes('deposit_addresses')) {
        if (path.includes('limit=1')) return { data: [{ address: '0xabc' }] }
        return { address: '0xnew' }
      }
      return {}
    }),
  }
}

function createHostedFeePayerStripeClient(): StripeClient {
  return {
    ...createMockStripeClient(),
    _requestSender: { _request: vi.fn() },
  }
}

function findMethod(methods: readonly AnyServer[], name: string, intent: string) {
  return methods.find((m) => m.name === name && m.intent === intent)!
}

const mockResolver = async () => '0xabc'

describe('stripe.create() defaultMethods', () => {
  test('returns tempo and spt methods', async () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: mockResolver,
    })

    const methods = await mp.defaultMethods()

    expect(findMethod(methods, 'tempo', 'charge')).toBeDefined()
    expect(findMethod(methods, 'stripe', 'charge')).toBeDefined()
  })

  test('forwards metadata to SPT method defaults', () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr' },
      metadata: { agent_id: 'test-agent' },
    })
    const methods = mp.defaultMethods()
    const sptMethod = findMethod(methods, 'stripe', 'charge')

    expect((sptMethod as any).defaults?.metadata).toEqual({ agent_id: 'test-agent' })
  })

  test('forwards metadata to crypto PI recording', async () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr' },
      metadata: { agent_id: 'test-agent' },
    })
    const methods = mp.defaultMethods()
    const tempoMethod = findMethod(methods, 'tempo', 'charge')

    await tempoMethod.onPaymentSuccess!({
      receipt: { reference: '0xtx123' },
      request: { amount: '500000' },
      requestInput: { paymentIntentOptions: { metadata: { request_id: 'req_123' } } },
    })

    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { agent_id: 'test-agent', machine_payment: 'true', request_id: 'req_123' },
      }),
      expect.anything(),
    )
  })

  test('uses Stripe feepayer when hostedFeePayer set', async () => {
    const client = createHostedFeePayerStripeClient()
    const methods = stripe({
      client,
      networkId: 'test-profile',
      livemode: true,
      hostedFeePayer: true,
      depositAddresses: { tempo: '0xtempoaddr' },
    }).defaultMethods()

    const chargeRequest = await findMethod(methods, 'tempo', 'charge').request!({
      request: {
        amount: '10000',
        currency: 'test-currency',
        decimals: 6,
        recipient: 'test-recipient',
      },
    } as never)

    expect(chargeRequest.feePayer).toBe(true)
    expect(JSON.stringify(chargeRequest)).not.toContain('mpp.stripe.com')
  })

  test('does not use Stripe feepayer when hostedFeePayer unset', async () => {
    const client = createMockStripeClient()
    const methods = stripe({
      client,
      networkId: 'test-profile',
      livemode: true,
      depositAddresses: { tempo: '0xtempoaddr' },
    }).defaultMethods()

    const request = await findMethod(methods, 'tempo', 'charge').request!({
      request: {
        amount: '10000',
        currency: 'test-currency',
        decimals: 6,
        recipient: 'test-recipient',
      },
    } as never)

    expect(request.feePayer).toBeUndefined()
  })

  test('rejects Stripe feepayer in test mode', () => {
    const client = createHostedFeePayerStripeClient()

    expect(() =>
      stripe({
        client,
        networkId: 'test-profile',
        livemode: false,
        hostedFeePayer: true,
      }),
    ).toThrow('requires a live-mode integration')
  })

  test('rejects Stripe feepayer with Connect', () => {
    const client = createHostedFeePayerStripeClient()

    expect(() =>
      stripe({
        client,
        networkId: 'test-profile',
        livemode: true,
        hostedFeePayer: true,
        connect: { stripeAccount: 'acct_connected' },
      }),
    ).toThrow('does not support Connect account routing')
  })

  test('rejects Stripe feepayer without Stripe request transport', () => {
    expect(() =>
      stripe({
        client: createMockStripeClient(),
        networkId: 'test-profile',
        livemode: true,
        hostedFeePayer: true,
      }),
    ).toThrow('requires a compatible Stripe Node SDK client')
  })

  test.each(['tempo', 'spt'] as const)('exclude removes %s', async (excluded) => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: mockResolver,
    })

    const methods = await mp.defaultMethods({ exclude: [excluded] })
    const expectedName = excluded === 'spt' ? 'stripe' : excluded

    expect(methods.find((m) => m.name === expectedName && m.intent === 'charge')).toBeUndefined()
    expect(methods.length).toBeGreaterThan(0)
  })
})

describe('stripe.create() PI recording', () => {
  test('onPaymentSuccess handler returns a Promise', async () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: mockResolver,
    })

    const methods = await mp.defaultMethods()
    const tempoMethod = findMethod(methods, 'tempo', 'charge')
    expect(tempoMethod.onPaymentSuccess).toBeTypeOf('function')

    const result = tempoMethod.onPaymentSuccess!({
      receipt: { reference: '0xtx123' },
      request: { amount: '500000' },
    })

    expect(result).toBeInstanceOf(Promise)
    await result
    expect(client.paymentIntents.create).toHaveBeenCalledOnce()
  })

  test('onPaymentSuccess returns undefined when receipt has no reference', async () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: mockResolver,
    })

    const methods = await mp.defaultMethods()
    const tempoMethod = findMethod(methods, 'tempo', 'charge')

    const result = tempoMethod.onPaymentSuccess!({
      receipt: {},
      request: { amount: '500000' },
    })

    expect(result).toBeUndefined()
    expect(client.paymentIntents.create).not.toHaveBeenCalled()
  })
})

describe('stripe.create() canOffer minimum amount', () => {
  test('tempo rejects amounts below 1 cent', () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr' },
    })
    const methods = mp.defaultMethods()
    const tempoMethod = findMethod(methods, 'tempo', 'charge')

    expect(
      tempoMethod.canOffer!({ input: new Request('http://x'), request: { amount: '9999' } }),
    ).toBe(false)
    expect(
      tempoMethod.canOffer!({ input: new Request('http://x'), request: { amount: '10000' } }),
    ).toBe(true)
  })

  test('custom rail inherits minimum amount check', () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })
    const methods = mp.defaultMethods().additional({
      solana: (_address) => ({
        name: 'solana',
        intent: 'charge',
        schema: {
          request: { parse: (x: unknown) => x },
          response: { parse: (x: unknown) => x },
        } as AnyServer['schema'],
      }),
    })
    const solanaMethod = findMethod(methods, 'solana', 'charge')

    expect(
      solanaMethod.canOffer!({ input: new Request('http://x'), request: { amount: '5000' } }),
    ).toBe(false)
    expect(
      solanaMethod.canOffer!({ input: new Request('http://x'), request: { amount: '10000' } }),
    ).toBe(true)
  })
})

describe('stripe.create() custom hook composition', () => {
  test('keeps PaymentIntent options out of custom rail lifecycle hooks', async () => {
    const client = createMockStripeClient()
    const parseStrictRequest = (request: Record<string, unknown>) => {
      if ('paymentIntentOptions' in request) throw new Error('unknown PaymentIntent options')
      return request
    }
    const validate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      parseStrictRequest(request)
      return {} as never
    })
    const broadcast = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      parseStrictRequest(request)
      return {
        method: 'solana',
        reference: '0xsolhash',
        status: 'success' as const,
        timestamp: new Date().toISOString(),
      }
    })
    const verify = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      parseStrictRequest(request)
      return {
        method: 'solana',
        reference: '0xsolhash',
        status: 'success' as const,
        timestamp: new Date().toISOString(),
      }
    })
    const respond = vi.fn(({ request }: { request: Record<string, unknown> }) => {
      parseStrictRequest(request)
    })
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })
    const methods = mp.defaultMethods().additional({
      solana: (_address) =>
        ({
          name: 'solana',
          intent: 'charge',
          schema: {
            credential: { payload: { parse: (x: unknown) => x } },
            request: { parse: (x: unknown) => x },
          },
          broadcast,
          respond,
          validate,
          verify,
        }) as AnyServer,
    })
    const method = findMethod(methods, 'solana', 'charge')
    const request = await method.request!({
      request: {
        amount: '10000',
        paymentIntentOptions: { metadata: { request_id: 'req_123' } },
      },
    })

    expect(request).toHaveProperty('paymentIntentOptions')
    const context = { credential: {} as never, request }
    await method.validate!(context)
    const receipt = await method.broadcast!(context)
    await method.verify(context)
    await method.respond!({ credential: {} as never, receipt, request } as never)
    expect(validate).toHaveBeenCalledOnce()
    expect(broadcast).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledOnce()
  })

  test('composes user hook with PI recorder for custom rails', async () => {
    const client = createMockStripeClient()
    const userHookCalls: unknown[] = []

    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })

    const methods = mp.defaultMethods().additional({
      solana: (_address) => ({
        name: 'solana',
        intent: 'charge',
        schema: {
          request: { parse: (x: unknown) => x },
          response: { parse: (x: unknown) => x },
        } as AnyServer['schema'],
        onPaymentSuccess: (params: unknown) => {
          userHookCalls.push(params)
        },
      }),
    })

    const solanaMethod = findMethod(methods, 'solana', 'charge')

    const params = { receipt: { reference: '0xsolhash' }, request: { amount: '10000' } }
    const result = solanaMethod.onPaymentSuccess!(params)
    expect(result).toBeInstanceOf(Promise)
    await result

    expect(userHookCalls).toHaveLength(1)
    expect(userHookCalls[0]).toBe(params)
    expect(client.paymentIntents.create).toHaveBeenCalledOnce()
  })

  test('uses recorder alone when custom rail has no user hook', async () => {
    const client = createMockStripeClient()

    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })

    const methods = mp.defaultMethods().additional({
      solana: (_address) => ({
        name: 'solana',
        intent: 'charge',
        schema: {
          request: { parse: (x: unknown) => x },
          response: { parse: (x: unknown) => x },
        } as AnyServer['schema'],
      }),
    })

    const solanaMethod = findMethod(methods, 'solana', 'charge')

    await solanaMethod.onPaymentSuccess!({
      receipt: { reference: '0xsolhash' },
      request: { amount: '10000' },
    })

    expect(client.paymentIntents.create).toHaveBeenCalledOnce()
  })
})

describe('stripe.create() deposit address cache isolation', () => {
  test('different clients do not share cached addresses', async () => {
    const client1 = createMockStripeClient()
    const client2: StripeClient = {
      paymentIntents: { create: vi.fn(async () => ({ id: 'pi_2', status: 'succeeded' })) },
      rawRequest: vi.fn(async () => ({ data: [{ address: '0xdifferent' }] })),
    }

    const mp1 = stripe({ client: client1, networkId: 'profile1', livemode: false })
    const mp2 = stripe({ client: client2, networkId: 'profile2', livemode: true })

    const addr1 = await mp1.findOrCreateDepositAddress('tempo')
    const addr2 = await mp2.findOrCreateDepositAddress('tempo')

    expect(addr1).toBe('0xabc')
    expect(addr2).toBe('0xdifferent')
    expect(client1.rawRequest).toHaveBeenCalledOnce()
    expect(client2.rawRequest).toHaveBeenCalledOnce()
  })

  test('same client reuses cached address', async () => {
    const client = createMockStripeClient()
    const mp = stripe({ client, networkId: 'profile', livemode: false })

    const addr1 = await mp.findOrCreateDepositAddress('tempo')
    const addr2 = await mp.findOrCreateDepositAddress('tempo')

    expect(addr1).toBe(addr2)
    expect(client.rawRequest).toHaveBeenCalledOnce()
  })
})

describe('stripe methods composed with non-stripe methods', () => {
  function makeIndependentMethod(): AnyServer {
    return {
      name: 'solana',
      intent: 'charge',
      schema: {
        request: { parse: (x: unknown) => x },
        response: { parse: (x: unknown) => x },
      } as AnyServer['schema'],
      onPaymentSuccess: vi.fn(),
    } as unknown as AnyServer
  }

  test('independent methods are not modified by stripe factory', () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr' },
    })
    const stripeMethods = mp.defaultMethods()
    const independent = makeIndependentMethod()
    const originalHook = independent.onPaymentSuccess

    const allMethods = [...stripeMethods, independent]
    const solana = allMethods.find((m) => m.name === 'solana')!

    expect(solana.onPaymentSuccess).toBe(originalHook)
    expect(solana.canOffer).toBeUndefined()
  })

  test('stripe PI recording does not fire for independent methods', async () => {
    const client = createMockStripeClient()
    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr' },
    })
    const stripeMethods = mp.defaultMethods()
    const independent = makeIndependentMethod()

    // Stripe tempo's hook records a PI
    const tempoMethod = findMethod(stripeMethods, 'tempo', 'charge')
    await tempoMethod.onPaymentSuccess!({
      receipt: { reference: '0xtx1' },
      request: { amount: '500000' },
    })
    expect(client.paymentIntents.create).toHaveBeenCalledOnce()

    // Independent method's hook does NOT touch stripe
    independent.onPaymentSuccess!({
      receipt: { reference: '0xtx2' },
      request: { amount: '500000' },
    })
    expect(client.paymentIntents.create).toHaveBeenCalledOnce()
    expect(independent.onPaymentSuccess).toHaveBeenCalledOnce()
  })
})

describe('stripe.create() canOffer composition with user hook', () => {
  test('user canOffer is checked after minimum amount passes', () => {
    const client = createMockStripeClient()
    const userCanOffer = vi.fn(() => false)

    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })
    const methods = mp.defaultMethods().additional({
      solana: (_address) => ({
        name: 'solana',
        intent: 'charge',
        schema: {
          request: { parse: (x: unknown) => x },
          response: { parse: (x: unknown) => x },
        } as AnyServer['schema'],
        canOffer: userCanOffer,
      }),
    })
    const solanaMethod = findMethod(methods, 'solana', 'charge')

    // Amount passes minimum but user rejects
    expect(
      solanaMethod.canOffer!({ input: new Request('http://x'), request: { amount: '50000' } }),
    ).toBe(false)
    expect(userCanOffer).toHaveBeenCalledOnce()
  })

  test('user canOffer is not called when amount is below minimum', () => {
    const client = createMockStripeClient()
    const userCanOffer = vi.fn(() => true)

    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: { tempo: '0xtempoaddr', solana: 'SOLaddr' },
    })
    const methods = mp.defaultMethods().additional({
      solana: (_address) => ({
        name: 'solana',
        intent: 'charge',
        schema: {
          request: { parse: (x: unknown) => x },
          response: { parse: (x: unknown) => x },
        } as AnyServer['schema'],
        canOffer: userCanOffer,
      }),
    })
    const solanaMethod = findMethod(methods, 'solana', 'charge')

    // Amount below minimum - short-circuits, user hook never called
    expect(
      solanaMethod.canOffer!({ input: new Request('http://x'), request: { amount: '5000' } }),
    ).toBe(false)
    expect(userCanOffer).not.toHaveBeenCalled()
  })
})

describe('stripe.create() graceful degradation', () => {
  test('partial resolver failure returns successful methods and warns', async () => {
    const client = createMockStripeClient()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mp = stripe({
      client,
      networkId: 'test-profile',
      livemode: false,
      depositAddresses: async (network) => {
        if (network === 'tempo') throw new Error('API unavailable')
        return '0x1234567890abcdef1234567890abcdef12345678'
      },
    })

    const methods = await mp.defaultMethods().additional({
      base: {
        x402: { facilitator: { verify: async () => ({}), settle: async () => ({}) } } as any,
      },
    })

    expect(methods.find((m) => m.name === 'tempo')).toBeUndefined()
    expect(findMethod(methods, 'evm', 'charge')).toBeDefined()
    expect(findMethod(methods, 'stripe', 'charge')).toBeDefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tempo method excluded'))

    warnSpy.mockRestore()
  })

  test('no depositAddresses returns sync SPT-only with .additional()', () => {
    const client = createMockStripeClient()
    const mp = stripe({ client, networkId: 'test-profile', livemode: false })

    const methods = mp.defaultMethods()
    expect(methods.additional).toBeTypeOf('function')

    const withAdditional = methods.additional({})
    expect(findMethod(withAdditional, 'stripe', 'charge')).toBeDefined()
  })
})
