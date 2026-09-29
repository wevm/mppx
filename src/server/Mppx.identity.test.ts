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

test.each(['broadcastCredential', 'verifyCredential', 'validateCredential'] as const)(
  '%s selects the later configured currency before dispatch',
  async (operation) => {
    const receipt = {
      method: 'tempo',
      status: 'success',
      reference: 'mock',
      timestamp: '2026-09-29T00:00:00Z',
    } as const
    const firstSuccess = vi.fn()
    const secondSuccess = vi.fn()
    const firstVerify = vi.fn(async () => receipt)
    const secondVerify = vi.fn(async () => receipt)
    const firstValidate = vi.fn(async () => ({}))
    const secondValidate = vi.fn(async () => ({}))
    const first = {
      ...makeCharge(currencies[0]),
      verify: firstVerify,
      broadcast: firstVerify,
      validate: firstValidate,
      onPaymentSuccess: firstSuccess,
    }
    const second = {
      ...makeCharge(currencies[1]),
      verify: secondVerify,
      broadcast: secondVerify,
      validate: secondValidate,
      onPaymentSuccess: secondSuccess,
    }
    const mppx = Mppx.create({ ...config, methods: [first, second] })
    const offered = await mppx.compose(
      [first, { amount: '1' }],
      [second, { amount: '1' }],
    )(new Request('https://example.test'))
    if (offered.status !== 402) throw new Error()
    const challenge = Challenge.fromResponseList(offered.challenge)[1]!
    const credential = Credential.from({
      challenge,
      payload: { type: 'hash', hash: `0x${'1'.repeat(64)}` },
    })
    await mppx[operation](credential)
    expect(firstVerify).not.toHaveBeenCalled()
    expect(firstValidate).not.toHaveBeenCalled()
    expect(firstSuccess).not.toHaveBeenCalled()
    if (operation === 'validateCredential') {
      expect(secondValidate).toHaveBeenCalledTimes(1)
      expect(secondVerify).not.toHaveBeenCalled()
      expect(secondSuccess).not.toHaveBeenCalled()
    } else {
      expect(secondVerify).toHaveBeenCalledTimes(1)
      expect(secondSuccess).toHaveBeenCalledTimes(1)
    }
  },
)

test('standalone dispatch rejects indistinguishable configured methods before callbacks', async () => {
  const verify = vi.fn()
  const onPaymentSuccess = vi.fn()
  const first = { ...makeCharge(currencies[0]), verify, onPaymentSuccess }
  const second = { ...makeCharge(currencies[0]), verify, onPaymentSuccess }
  const mppx = Mppx.create({ ...config, methods: [first, second] })
  const offered = await mppx.compose([second, { amount: '1' }])(new Request('https://example.test'))
  if (offered.status !== 402) throw new Error()
  const credential = Credential.from({
    challenge: Challenge.fromResponse(offered.challenge),
    payload: { type: 'hash', hash: `0x${'1'.repeat(64)}` },
  })
  await expect(mppx.broadcastCredential(credential)).rejects.toThrow('multiple configured methods')
  expect(verify).not.toHaveBeenCalled()
  expect(onPaymentSuccess).not.toHaveBeenCalled()
})

test.each([false, true])(
  'standalone selection uses transformed stable bindings (route input: %s)',
  async (routeInput) => {
    const definition = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.pipe(
          z.object({ amount: z.string(), plan: z.string() }),
          z.transform(({ amount, plan }) => ({
            amount: String(Number(amount) * 100),
            methodDetails: { plan },
          })),
        ),
      },
    })
    const receipt = {
      method: 'mock',
      status: 'success',
      reference: 'second',
      timestamp: '2026-09-29T00:00:00Z',
    } as const
    const firstVerify = vi.fn(async () => receipt)
    const secondVerify = vi.fn(async () => receipt)
    const firstSuccess = vi.fn()
    const secondSuccess = vi.fn()
    const first = Method.toServer(definition, {
      defaults: { ...(routeInput ? {} : { amount: '1' }), plan: 'first' },
      stableBinding: (request) => ({ amount: request.amount, plan: request.methodDetails.plan }),
      verify: firstVerify,
      onPaymentSuccess: firstSuccess,
    })
    const second = Method.toServer(definition, {
      defaults: { ...(routeInput ? {} : { amount: '1' }), plan: 'second' },
      stableBinding: (request) => ({ amount: request.amount, plan: request.methodDetails.plan }),
      verify: secondVerify,
      onPaymentSuccess: secondSuccess,
    })
    const mppx = Mppx.create({ ...config, methods: [first, second] })
    const offered = await mppx.compose([second, { amount: '1', plan: 'second' }])(
      new Request('https://example.test'),
    )
    if (offered.status !== 402) throw new Error()
    const credential = Credential.from({
      challenge: Challenge.fromResponse(offered.challenge),
      payload: { token: 'valid' },
    })
    await mppx.broadcastCredential(
      credential,
      routeInput ? { request: { amount: '1' } } : undefined,
    )
    expect(firstVerify).not.toHaveBeenCalled()
    expect(firstSuccess).not.toHaveBeenCalled()
    expect(secondVerify).toHaveBeenCalledTimes(1)
    expect(secondSuccess).toHaveBeenCalledTimes(1)
  },
)

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
      request: z.object({ amount: z.string(), currency: z.string() }),
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
    defaults: { currency: 'A' },
    authorize: async () =>
      flow === 'authorize' || flow === 'throwing hook' ? { receipt } : undefined,
    verify: async () => receipt,
    onPaymentSuccess: aSuccess,
  })
  const b = Method.toServer(definition, {
    ...(alias ? ({ alias: 'b' } as const) : {}),
    defaults: { currency: 'B' },
    verify: async () => receipt,
    onPaymentSuccess: bSuccess,
  })
  const mppx = Mppx.create({ ...config, methods: [a, b] })
  const globalSuccess = vi.fn()
  const allEvents = vi.fn()
  mppx.onPaymentSuccess(globalSuccess)
  mppx.on('*', allEvents)
  const handler = mppx.compose([a, { amount: '1', currency: 'A' }])
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
