import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import { expect, test, vi } from 'vp/test'

const config = { realm: 'example.test', secretKey: 'test-secret-key-test-secret-key-32' }
const currencies = [
  '0x20c0000000000000000000000000000000000001',
  '0x20c0000000000000000000000000000000000002',
] as const
const makeCharge = (currency: (typeof currencies)[number]) =>
  tempo.charge({
    currency,
    chainId: 42431,
    recipient: '0x0000000000000000000000000000000000000001',
  })

test.each([false, true])(
  'explicit composition preserves currency order (reverse: %s)',
  async (reverse) => {
    const a = makeCharge(currencies[0])
    const b = makeCharge(currencies[1])
    const mppx = Mppx.create({ ...config, methods: [a, b] })
    const ordered = reverse ? ([b, a] as const) : ([a, b] as const)
    const result = await mppx.compose(
      [ordered[0], { amount: '1' }],
      [ordered[1], { amount: '1' }],
    )(new Request('https://example.test'))
    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error()
    expect(Challenge.fromResponseList(result.challenge).map((c) => c.request.currency)).toEqual(
      reverse ? [...currencies].reverse() : currencies,
    )
  },
)

test('unregistered method reference is rejected even with a matching wire key', () => {
  const a = makeCharge(currencies[0])
  const b = makeCharge(currencies[1])
  const mppx = Mppx.create({ ...config, methods: [a] })
  expect(() => mppx.compose([b, { amount: '1' }])).toThrow('No handler')
})

test.each([
  { flow: 'authorize', alias: false },
  { flow: 'authorize', alias: true },
  { flow: 'verify', alias: false },
  { flow: 'verify', alias: true },
  { flow: 'standalone', alias: false },
  { flow: 'standalone', alias: true },
  { flow: 'throwing hook', alias: true },
])('scopes success callbacks ($flow, alias: $alias)', async ({ flow, alias }) => {
  const definition = Method.from({
    name: 'mock',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ token: z.string() }) },
      request: z.object({ amount: z.string() }),
    },
  })
  const receipt = {
    method: 'mock',
    status: 'success',
    reference: 'mock-receipt',
    timestamp: '2026-09-29T00:00:00Z',
  } as const
  const aSuccess = vi.fn(() => {
    if (flow === 'throwing hook') throw new Error('hook failed')
  })
  const bSuccess = vi.fn()
  const a = Method.toServer(definition, {
    ...(alias ? ({ alias: 'a' } as const) : {}),
    authorize: async () =>
      flow === 'authorize' || flow === 'throwing hook' ? { receipt } : undefined,
    verify: async () => receipt,
    onPaymentSuccess: aSuccess,
  })
  const b = Method.toServer(definition, {
    ...(alias ? ({ alias: 'b' } as const) : {}),
    verify: async () => receipt,
    onPaymentSuccess: bSuccess,
  })
  const mppx = Mppx.create({ ...config, methods: [a, b] })
  const globalSuccess = vi.fn()
  const allEvents = vi.fn()
  mppx.onPaymentSuccess(globalSuccess)
  mppx.on('*', allEvents)
  const handler = mppx.compose([a, { amount: '1' }])
  const initial = await handler(new Request('https://example.test'))
  if (flow === 'verify' || flow === 'standalone') {
    expect(initial.status).toBe(402)
    if (initial.status !== 402) throw new Error()
    const credential = Credential.from({
      challenge: Challenge.fromResponse(initial.challenge),
      payload: { token: 'valid' },
    })
    if (flow === 'standalone') {
      expect(await mppx.broadcastCredential(credential)).toEqual(receipt)
    } else {
      const paid = await handler(
        new Request('https://example.test', {
          headers: { Authorization: Credential.serialize(credential) },
        }),
      )
      expect(paid.status).toBe(200)
    }
  } else expect(initial.status).toBe(200)
  expect(globalSuccess).toHaveBeenCalledTimes(1)
  expect(allEvents.mock.calls.filter(([event]) => event.name === 'payment.success')).toHaveLength(1)
  expect(aSuccess.mock.invocationCallOrder[0]).toBeLessThan(
    globalSuccess.mock.invocationCallOrder[0]!,
  )
  expect(aSuccess).toHaveBeenCalledTimes(1)
  expect(bSuccess).not.toHaveBeenCalled()
})
