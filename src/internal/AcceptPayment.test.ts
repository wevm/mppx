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

  test('parse rejects empty and malformed headers', () => {
    expect(() => AcceptPayment.parse('')).toThrow('Accept-Payment header is empty.')
    expect(() => AcceptPayment.parse('tempo')).toThrow('Invalid Accept-Payment entry: tempo')
    expect(() => AcceptPayment.parse('Tempo/charge')).toThrow(
      'Invalid Accept-Payment method: Tempo',
    )
    expect(() => AcceptPayment.parse('tempo/charge;q')).toThrow(
      'Invalid Accept-Payment parameter: q',
    )
    expect(() => AcceptPayment.parse('tempo/charge;q=1.001')).toThrow('Expected an HTTP qvalue')
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

  test('rank applies the most specific match before q-value filtering', () => {
    const preferences = AcceptPayment.parse('tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5')

    expect(
      AcceptPayment.rank(
        [
          { method: 'tempo', intent: 'charge' },
          { method: 'stripe', intent: 'charge' },
        ],
        preferences,
      ),
    ).toEqual([{ method: 'stripe', intent: 'charge' }])
  })

  test('rank excludes offers matched only by q=0 preferences', () => {
    const preferences = AcceptPayment.parse('tempo/charge;q=0, stripe/*;q=0.1')

    expect(
      AcceptPayment.rank(
        [
          { method: 'tempo', intent: 'charge' },
          { method: 'stripe', intent: 'session' },
        ],
        preferences,
      ),
    ).toEqual([{ method: 'stripe', intent: 'session' }])
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

  test('selectChallenge honors a specific opt-out over a broader wildcard', () => {
    const selected = AcceptPayment.selectChallenge(
      [
        { id: '1', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
        { id: '2', intent: 'charge', method: 'stripe', realm: 'test', request: {} },
      ],
      [
        { name: 'tempo', intent: 'charge' },
        { name: 'stripe', intent: 'charge' },
      ] as const,
      AcceptPayment.parse('tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5'),
    )

    expect(selected?.challenge.id).toBe('2')
    expect(selected?.method).toEqual({ name: 'stripe', intent: 'charge' })
  })

  test('selectChallenge returns undefined when supported offers are disabled', () => {
    const selected = AcceptPayment.selectChallenge(
      [
        { id: '1', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
        { id: '2', intent: 'charge', method: 'stripe', realm: 'test', request: {} },
      ],
      [{ name: 'tempo', intent: 'charge' }] as const,
      AcceptPayment.parse('tempo/charge;q=0, stripe/charge'),
    )

    expect(selected).toBeUndefined()
  })

  test('throws for unknown payment preference keys', () => {
    expect(() =>
      AcceptPayment.resolve(
        [{ name: 'tempo', intent: 'charge' }] as const,
        {
          'stripe/charge': 1,
        } as never,
      ),
    ).toThrow('Unknown payment preference "stripe/charge"')
  })

  test('throws for invalid configured q-values', () => {
    expect(() =>
      AcceptPayment.resolve([{ name: 'tempo', intent: 'charge' }] as const, {
        'tempo/charge': 0.3333,
      }),
    ).toThrow('Expected at most 3 decimal places')
  })

  test('throws for non-finite configured q-values', () => {
    expect(() =>
      AcceptPayment.resolve([{ name: 'tempo', intent: 'charge' }] as const, {
        'tempo/charge': Number.POSITIVE_INFINITY,
      }),
    ).toThrow('Expected a finite number')
  })
})
