import * as Identity from 'mppx/identity'
import { expect, test, vi } from 'vp/test'

const request = () => new Request('https://merchant.example/resource')
const valid = <value>(value: value): Identity.Verifier<value> => ({
  verify: () => ({ status: 'valid', value }),
})
const missing = (headers?: HeadersInit): Identity.Verifier => ({
  verify: () => ({ status: 'missing', headers }),
})
const rejecting = (
  status: 'invalid' | 'forbidden' | 'unavailable',
  headers?: HeadersInit,
): Identity.Verifier => ({
  verify: () => ({ status, reason: `${status} proof`, headers }),
})
const verify = (verifiers: readonly Identity.Verifier[], input = request()) =>
  Identity.Server.verify(Identity.Server.createContext(), input, verifiers)
const headersOf = (outcome: Identity.Server.Outcome) =>
  outcome.status === 'valid' ? [] : outcome.headers.map(([name, value]) => [name, value])

test('exports fixed status codes and precedence as data', () => {
  expect(Identity.Status.codes).toEqual({
    missing: 401,
    invalid: 401,
    forbidden: 403,
    unavailable: 503,
  })
  expect(Identity.Status.precedence).toEqual(['forbidden', 'unavailable', 'invalid', 'missing'])
})

test('requires every verifier and exposes values by verifier', async () => {
  const a = valid('a')
  const b = valid(2)
  const outcome = await verify([a, b])
  expect(outcome.status).toBe('valid')
  const state = Identity.Server.transition(Identity.Server.initial, { type: 'verified', outcome })
  const results = Identity.Server.results(state)
  expect(Object.isFrozen(results)).toBe(true)
  expect(results.get(a)).toBe('a')
  expect(results.get(b)).toBe(2)
  expect(results.get(valid('unused'))).toBeUndefined()
})

test("missing defaults to 401 and merges every rejected outcome's headers", async () => {
  const outcome = await verify([
    valid('a'),
    missing({ 'Proof-Request': 'one' }),
    missing({ 'Accept-Signature': 'two' }),
  ])
  expect(outcome).toMatchObject({ status: 'missing', code: 401 })
  expect(headersOf(outcome)).toEqual([
    ['proof-request', 'one'],
    ['accept-signature', 'two'],
  ])
})

test('the rejected outcome with the highest precedence decides status and reason', async () => {
  for (const [verifiers, status, code] of [
    [[missing(), rejecting('invalid')], 'invalid', 401],
    [[rejecting('invalid'), rejecting('unavailable')], 'unavailable', 503],
    [[rejecting('unavailable'), rejecting('forbidden'), missing()], 'forbidden', 403],
  ] as const) {
    const outcome = await verify(verifiers)
    expect(outcome).toMatchObject({ status, code, reason: `${status} proof` })
  }
  const outcome = await verify([
    rejecting('forbidden', { A: '1' }),
    missing({ B: '2' }),
    rejecting('invalid', { C: '3' }),
  ])
  expect(headersOf(outcome)).toEqual([
    ['a', '1'],
    ['b', '2'],
    ['c', '3'],
  ])
})

test('honors the deprecated code: 403 is forbidden, 503 unavailable, others sent as is', async () => {
  const coded = (status: 'missing' | 'invalid', code: number): Identity.Verifier => ({
    verify: () => ({ status, code, reason: 'coded' }),
  })
  expect(await verify([coded('invalid', 403)])).toMatchObject({ status: 'forbidden', code: 403 })
  expect(await verify([coded('invalid', 503)])).toMatchObject({ status: 'unavailable', code: 503 })
  expect(await verify([coded('missing', 403)])).toMatchObject({ status: 'forbidden', code: 403 })
  expect(await verify([coded('invalid', 400)])).toMatchObject({ status: 'invalid', code: 400 })
  // A forbidden outcome outranks an invalid one even when invalid comes first.
  expect(await verify([coded('invalid', 401), coded('invalid', 403)])).toMatchObject({
    status: 'forbidden',
  })
})

test('anyOf accepts the first valid member and reports both values', async () => {
  const first = missing({ 'Accept-Signature': 'tap' })
  const second = valid('wba')
  const agent = Identity.anyOf(first, second)
  const outcome = await verify([agent])
  if (outcome.status !== 'valid') throw new Error()
  expect(outcome.values.get(agent)).toEqual({ index: 1, value: 'wba' })
  expect(outcome.values.get(second)).toBe('wba')
  expect(outcome.values.has(first)).toBe(false)
})

test('anyOf applies the precedence rule and merges member headers', async () => {
  const outcome = await verify([Identity.anyOf(missing({ A: '1' }), missing({ B: '2' }))])
  expect(outcome).toMatchObject({
    status: 'missing',
    code: 401,
    reason: 'None of the accepted identity proofs was presented.',
  })
  expect(headersOf(outcome)).toEqual([
    ['a', '1'],
    ['b', '2'],
  ])
  expect(
    await verify([Identity.anyOf(rejecting('invalid'), rejecting('unavailable'), missing())]),
  ).toMatchObject({ status: 'unavailable', code: 503, reason: 'unavailable proof' })
  // Called directly, an anyOf verifier returns the same decision as a verification.
  expect(
    await Identity.anyOf(missing(), rejecting('forbidden', { X: '1' })).verify(request()),
  ).toEqual({ status: 'forbidden', headers: [['x', '1']], reason: 'forbidden proof' })
})

test('runs each verifier once per context, across anyOf members', async () => {
  const run = vi.fn(() => ({ status: 'valid', value: true }) as const)
  const verifier: Identity.Verifier<boolean> = { verify: run }
  const input = request()
  const context = Identity.Server.createContext()
  await Identity.Server.verify(context, input, [verifier])
  await Identity.Server.verify(context, input, [Identity.anyOf(verifier, valid(false))])
  expect(run).toHaveBeenCalledTimes(1)
  await Identity.Server.verify(Identity.Server.createContext(), input, [verifier])
  expect(run).toHaveBeenCalledTimes(2)
})

test('records the matched leaf through nested anyOf', async () => {
  const leaf = valid('leaf')
  const inner = Identity.anyOf(missing(), leaf)
  const outer = Identity.anyOf(missing(), inner)
  const outcome = await verify([outer])
  if (outcome.status !== 'valid') throw new Error()
  expect(outcome.values.get(leaf)).toBe('leaf')
  expect(outcome.values.get(inner)).toEqual({ index: 1, value: 'leaf' })
})

test('anyOf runs every member so each presented proof is consumed', async () => {
  const second = vi.fn(() => ({ status: 'valid', value: 'b' }) as const)
  const agent = Identity.anyOf(valid('a'), { verify: second })
  const outcome = await verify([agent])
  if (outcome.status !== 'valid') throw new Error()
  expect(outcome.values.get(agent)).toEqual({ index: 0, value: 'a' })
  expect(second).toHaveBeenCalledTimes(1)
})

test('rejects payment-stage and unknown-stage verifiers instead of skipping them', () => {
  const payment: Identity.Verifier = { stage: 'payment', verify: () => ({ status: 'missing' }) }
  expect(() => Identity.Server.route([payment])).toThrow('identity: { payment }')
  expect(() => Identity.anyOf(valid('a'), payment)).toThrow('identity: { payment }')
  expect(() =>
    Identity.Server.route([{ stage: 'Payment' as never, verify: () => ({ status: 'missing' }) }]),
  ).toThrow('Unknown identity verifier stage "Payment".')
  expect(Identity.Server.route([{ stage: 'request', ...valid('a') }]).request).toHaveLength(1)
})

test('parses both route identity shapes and validates payment requirements', () => {
  const verifier = valid('a')
  const payment: Identity.PaymentCheck = {
    requires: [{ type: 'kyc', issuer: 'https://kyc.example' }],
    verify: () => ({ status: 'missing' }),
  }
  expect(Identity.Server.route([verifier])).toEqual({ payment: undefined, request: [verifier] })
  expect(Identity.Server.route({ payment })).toEqual({ payment, request: [] })
  expect(Object.isFrozen(Identity.Server.route(undefined))).toBe(true)
  expect(() =>
    Identity.Server.route({ payment: { ...payment, requires: [{ type: 'not a token' }] } }),
  ).toThrow(TypeError)
})

test('a payment check outcome is keyed by the check', async () => {
  const check: Identity.PaymentCheck<string> = {
    requires: [],
    verify: ({ credential }) =>
      credential ? { status: 'valid', value: 'kyc-1' } : { status: 'missing' },
  }
  const challenge = { id: 'c' } as never
  const outcome = await Identity.Server.check(check, {
    challenge,
    credential: { challenge, payload: {} } as never,
    request: request(),
  })
  if (outcome.status !== 'valid') throw new Error()
  expect(outcome.values.get(check)).toBe('kyc-1')
  expect(await Identity.Server.check(check, { challenge, request: request() })).toMatchObject({
    status: 'missing',
    code: 401,
  })
})

test('server transitions: request-stage rejection', async () => {
  const outcome = await verify([rejecting('forbidden', { 'X-Why': 'nope' })])
  const state = Identity.Server.transition(Identity.Server.initial, { type: 'verified', outcome })
  expect(state).toEqual({
    phase: 'rejected',
    rejection: { stage: 'request', status: 'forbidden', reason: 'forbidden proof' },
    code: 403,
    headers: [['x-why', 'nope']],
  })
  expect(Object.isFrozen(state)).toBe(true)
  if (state.phase !== 'rejected') throw new Error()
  expect(Object.isFrozen(state.rejection)).toBe(true)
  const response = Identity.Server.toResponse(state)
  expect([response.status, response.headers.get('X-Why'), await response.text()]).toEqual([
    403,
    'nope',
    'forbidden proof',
  ])
})

test('server transitions: paid retry accepted or rejected, authorize falls back to a 402', () => {
  const { initial, none, transition } = Identity.Server
  const check: Identity.PaymentCheck = { requires: [], verify: () => ({ status: 'missing' }) }
  const challenge = { id: 'c' } as never
  const credential = { challenge, payload: {} } as never
  const identified = transition(initial, { type: 'verified', outcome: none })
  expect(identified.phase).toBe('identified')

  const paying = transition(identified, { type: 'pay', challenge, credential })
  expect(paying).toMatchObject({ phase: 'payment', challenge, credential })
  const accepted = transition(paying, {
    type: 'checked',
    outcome: { status: 'valid', values: new Map([[check, 'v']]) },
  })
  expect(accepted.phase).toBe('accepted')
  expect(Identity.Server.results(accepted).get(check)).toBe('v')

  const rejectedOutcome = Identity.Server.decide([{ status: 'invalid', reason: 'no kyc' }])
  expect(transition(paying, { type: 'checked', outcome: rejectedOutcome })).toMatchObject({
    phase: 'rejected',
    rejection: { stage: 'payment', status: 'invalid', reason: 'no kyc' },
    code: 401,
  })

  const authorizing = transition(identified, { type: 'pay', challenge, credential: undefined })
  const unauthorized = transition(authorizing, { type: 'checked', outcome: rejectedOutcome })
  expect(unauthorized.phase).toBe('identified')
  const requirements = [{ type: 'kyc' }]
  expect(transition(unauthorized, { type: 'challenge', requirements })).toMatchObject({
    phase: 'challenged',
    requirements,
  })
  expect(transition(accepted, { type: 'challenge', requirements: [] }).phase).toBe('challenged')
})

test('server transitions: illegal transitions throw', () => {
  const { initial, none, transition } = Identity.Server
  const challenge = { id: 'c' } as never
  const identified = transition(initial, { type: 'verified', outcome: none })
  const challenged = transition(identified, { type: 'challenge', requirements: [] })
  const rejected = transition(initial, {
    type: 'verified',
    outcome: Identity.Server.decide([{ status: 'missing' }]),
  })
  const illegal = [
    [initial, { type: 'pay', challenge, credential: undefined }],
    [initial, { type: 'checked', outcome: none }],
    [initial, { type: 'challenge', requirements: [] }],
    [identified, { type: 'verified', outcome: none }],
    [identified, { type: 'checked', outcome: none }],
    [challenged, { type: 'challenge', requirements: [] }],
    [challenged, { type: 'pay', challenge, credential: undefined }],
    [rejected, { type: 'challenge', requirements: [] }],
    [rejected, { type: 'pay', challenge, credential: undefined }],
  ] as const
  for (const [state, event] of illegal)
    expect(() => transition(state, event)).toThrow(
      `Illegal identity transition "${event.type}" from phase "${state.phase}".`,
    )
  expect(() => Identity.Server.decide([])).toThrow(TypeError)
})

test('runs the own verify of a verifier derived from anyOf', async () => {
  const either = Identity.anyOf(valid('a'), valid('b'))
  const policy: Identity.Verifier = {
    ...either,
    verify: () => ({ status: 'forbidden', reason: 'policy' }),
  }
  const inherited: Identity.Verifier = Object.create(either, {
    verify: { value: () => ({ status: 'forbidden', reason: 'policy' }) },
  })
  expect((await verify([policy])).status).toBe('forbidden')
  expect((await verify([inherited])).status).toBe('forbidden')
  expect((await verify([either])).status).toBe('valid')
})
