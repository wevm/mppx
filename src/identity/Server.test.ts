import * as Identity from 'mppx/identity'
import { expect, test, vi } from 'vp/test'

const request = () => new Request('https://merchant.example/resource')
const valid = <value>(value: value): Identity.Verifier<value> => ({
  verify: () => ({ status: 'valid', value }),
})
const missing = (headers?: HeadersInit): Identity.Verifier => ({
  verify: () => ({ status: 'missing', headers }),
})
const invalid = (code?: number): Identity.Verifier => ({
  verify: () => ({ status: 'invalid', code, reason: 'bad proof', headers: { 'X-Error': 'bad' } }),
})

test('requires every verifier and exposes values by verifier', async () => {
  const a = valid('a')
  const b = valid(2)
  const outcome = await Identity.Server.verify(request(), [a, b])
  expect(outcome.status).toBe('valid')
  if (outcome.status !== 'valid') throw new Error()
  const results = Identity.Server.results(outcome.values)
  expect(results.get(a)).toBe('a')
  expect(results.get(b)).toBe(2)
  expect(results.get(valid('unused'))).toBeUndefined()
})

test('rejects missing proofs with 403 and merged challenge headers', async () => {
  const outcome = await Identity.Server.verify(request(), [
    valid('a'),
    missing({ 'Proof-Request': 'one' }),
    missing({ 'Accept-Signature': 'two' }),
  ])
  expect(outcome).toMatchObject({ status: 'missing', code: 403 })
  if (outcome.status === 'valid') throw new Error()
  expect(outcome.headers.get('Proof-Request')).toBe('one')
  expect(outcome.headers.get('Accept-Signature')).toBe('two')
  const response = Identity.Server.toResponse(outcome)
  expect(response.status).toBe(403)
  expect(response.headers.get('Proof-Request')).toBe('one')
})

test('prefers invalid outcomes and honors custom codes', async () => {
  expect(await Identity.Server.verify(request(), [missing(), invalid()])).toMatchObject({
    status: 'invalid',
    code: 401,
    reason: 'bad proof',
  })
  const outcome = await Identity.Server.verify(request(), [invalid(400)])
  expect(outcome).toMatchObject({ code: 400 })
  if (outcome.status === 'valid') throw new Error()
  expect(outcome.headers.get('X-Error')).toBe('bad')
})

test('anyOf accepts the first valid member and reports both values', async () => {
  const first = missing({ 'Accept-Signature': 'tap' })
  const second = valid('wba')
  const agent = Identity.anyOf(first, second)
  const outcome = await Identity.Server.verify(request(), [agent])
  if (outcome.status !== 'valid') throw new Error()
  const results = Identity.Server.results(outcome.values)
  expect(results.get(agent)).toEqual({ index: 1, value: 'wba' })
  expect(results.get(second)).toBe('wba')
  expect(results.get(first)).toBeUndefined()
})

test('anyOf merges member challenges and surfaces invalid members', async () => {
  const outcome = await Identity.Server.verify(request(), [
    Identity.anyOf(missing({ A: '1' }), missing({ B: '2' })),
  ])
  if (outcome.status === 'valid') throw new Error()
  expect([outcome.status, outcome.headers.get('A'), outcome.headers.get('B')]).toEqual([
    'missing',
    '1',
    '2',
  ])
  const custom: Identity.Verifier = { verify: () => ({ status: 'missing', code: 401 }) }
  expect(
    await Identity.Server.verify(request(), [Identity.anyOf(missing(), custom)]),
  ).toMatchObject({
    status: 'missing',
    code: 401,
  })
  expect(
    await Identity.Server.verify(request(), [Identity.anyOf(missing(), invalid())]),
  ).toMatchObject({ status: 'invalid' })
  expect(() =>
    Identity.anyOf(valid('a'), { stage: 'payment', verify: () => ({ status: 'missing' }) }),
  ).toThrow('Identity anyOf verifiers must run at the same stage.')
})

test('runs each verifier once per request and context', async () => {
  const verify = vi.fn(() => ({ status: 'valid', value: true }) as const)
  const verifier: Identity.Verifier<boolean> = { verify }
  const input = request()
  await Identity.Server.verify(input, [verifier])
  await Identity.Server.verify(input, [Identity.anyOf(verifier, valid(false))])
  expect(verify).toHaveBeenCalledTimes(1)
  await Identity.Server.verify(input, [verifier], { challenge: { id: 'a' } as never })
  await Identity.Server.verify(request(), [verifier])
  expect(verify).toHaveBeenCalledTimes(3)
})

test('records the matched leaf through nested anyOf', async () => {
  const leaf = valid('leaf')
  const inner = Identity.anyOf(missing(), leaf)
  const outer = Identity.anyOf(missing(), inner)
  const outcome = await Identity.Server.verify(request(), [outer])
  if (outcome.status !== 'valid') throw new Error()
  const results = Identity.Server.results(outcome.values)
  expect(results.get(leaf)).toBe('leaf')
  expect(results.get(inner)).toEqual({ index: 1, value: 'leaf' })
})

test('anyOf runs every member so each presented proof is consumed', async () => {
  const second = vi.fn(() => ({ status: 'valid', value: 'b' }) as const)
  const agent = Identity.anyOf(valid('a'), { verify: second })
  const outcome = await Identity.Server.verify(request(), [agent])
  if (outcome.status !== 'valid') throw new Error()
  expect(Identity.Server.results(outcome.values).get(agent)).toEqual({ index: 0, value: 'a' })
  expect(second).toHaveBeenCalledTimes(1)
})

test('rejects verifiers with an unknown stage instead of skipping them', () => {
  expect(() =>
    Identity.Server.stageOf({ stage: 'Payment' as never, verify: () => ({ status: 'missing' }) }),
  ).toThrow('Unknown identity verifier stage "Payment".')
})

test('does not reuse a decision across different credentials', async () => {
  const verify = vi.fn((_request: Request, { credential }: Identity.Context) =>
    (credential as { payload: { subject: string } }).payload.subject === 'alice'
      ? ({ status: 'valid', value: true } as const)
      : ({ status: 'invalid', reason: 'not alice' } as const),
  )
  const verifier: Identity.Verifier<boolean> = { stage: 'payment', verify }
  const input = request()
  const challenge = { id: 'a' } as never
  const alice = { payload: { subject: 'alice' } } as never
  const bob = { payload: { subject: 'bob' } } as never
  expect(
    (await Identity.Server.verify(input, [verifier], { challenge, credential: alice })).status,
  ).toBe('valid')
  expect(
    (await Identity.Server.verify(input, [verifier], { challenge, credential: bob })).status,
  ).toBe('invalid')
  expect(verify).toHaveBeenCalledTimes(2)
})
