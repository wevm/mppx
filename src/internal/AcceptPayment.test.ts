import { describe, expect, test } from 'vp/test'

import * as AcceptPayment from './AcceptPayment.js'

describe('AcceptPayment', () => {
  test('resolve builds a typed header from methods and overrides', () => {
    const resolved = AcceptPayment.resolve(
      [
        { name: 'tempo', intent: 'charge' },
        { name: 'tempo', intent: 'session' },
        { name: 'stripe', intent: 'charge' },
      ] as const,
      ({ tempo, stripe }) => ({
        [stripe.charge]: 0.5,
        [tempo.session]: 0,
      }),
    )

    expect(resolved.header).toBe('tempo/charge, tempo/session;q=0, stripe/charge;q=0.5')
    expect(resolved.keys.tempo.charge).toBe('tempo/charge')
    expect(resolved.keys.tempo.session).toBe('tempo/session')
    expect(resolved.keys.stripe.charge).toBe('stripe/charge')
  })

  test('parse supports q-values and wildcards', () => {
    expect(
      AcceptPayment.parse('tempo/*, stripe/charge;q=0.5, */session;q=0').map(
        ({ index: _index, ...entry }) => entry,
      ),
    ).toEqual([
      { intent: '*', method: 'tempo', q: 1 },
      { intent: 'charge', method: 'stripe', q: 0.5 },
      { intent: 'session', method: '*', q: 0 },
    ])
  })

  test('rank prefers higher q then preserves offer order for ties', () => {
    const offers = [
      { method: 'tempo', intent: 'charge' },
      { method: 'stripe', intent: 'charge' },
      { method: 'tempo', intent: 'session' },
    ]
    const preferences = AcceptPayment.parse(
      'stripe/charge;q=0.5, tempo/charge;q=0.9, tempo/session;q=0.9',
    )

    expect(AcceptPayment.rank(offers, preferences)).toEqual([
      { method: 'tempo', intent: 'charge' },
      { method: 'tempo', intent: 'session' },
      { method: 'stripe', intent: 'charge' },
    ])
  })

  test('rank prefers more specific wildcard matches', () => {
    const preferences = AcceptPayment.parse('tempo/*;q=0.5, tempo/session;q=0.5, */*;q=0.1')

    expect(AcceptPayment.rank([{ method: 'tempo', intent: 'session' }], preferences)).toEqual([
      { method: 'tempo', intent: 'session' },
    ])
  })

  test('selectChallenge returns the best supported offer', () => {
    const selected = AcceptPayment.selectChallenge(
      [
        { id: '1', intent: 'charge', method: 'stripe', realm: 'test', request: {} },
        { id: '2', intent: 'session', method: 'tempo', realm: 'test', request: {} },
      ],
      [
        { name: 'tempo', intent: 'session' },
        { name: 'stripe', intent: 'charge' },
      ] as const,
      AcceptPayment.parse('stripe/charge;q=0.5, tempo/session;q=0.9'),
    )

    expect(selected?.challenge.id).toBe('2')
    expect(selected?.method).toEqual({ name: 'tempo', intent: 'session' })
  })

  test('throws for invalid configured q-values', () => {
    expect(() =>
      AcceptPayment.resolve([{ name: 'tempo', intent: 'charge' }] as const, {
        'tempo/charge': 0.3333,
      }),
    ).toThrow('Expected at most 3 decimal places')
  })
})
