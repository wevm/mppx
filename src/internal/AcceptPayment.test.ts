import { describe, expect, test } from 'vp/test'

import * as x402_ChallengeBrand from '../x402/internal/ChallengeBrand.js'
import * as AcceptPayment from './AcceptPayment.js'

function stripIndex(entry: AcceptPayment.Entry) {
  const { index: _index, ...rest } = entry
  return rest
}

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
      AcceptPayment.parse('tempo/*, stripe/charge;q=0.5, */session;q=0').map(stripIndex),
    ).toEqual([
      { intent: '*', method: 'tempo', q: 1 },
      { intent: 'charge', method: 'stripe', q: 0.5 },
      { intent: 'session', method: '*', q: 0 },
    ])
  })

  test('parse raw header vectors into normalized entries', () => {
    const vectors = [
      {
        header: 'tempo/charge',
        entries: [{ intent: 'charge', method: 'tempo', q: 1 }],
        normalized: 'tempo/charge',
      },
      {
        header: ' stripe/charge ; q = 0.25 , */session ; q=0 ',
        entries: [
          { intent: 'charge', method: 'stripe', q: 0.25 },
          { intent: 'session', method: '*', q: 0 },
        ],
        normalized: 'stripe/charge;q=0.25, */session;q=0',
      },
      {
        header: 'tempo/*;q=1, tempo/charge;q=0, stripe/*;q=0.5',
        entries: [
          { intent: '*', method: 'tempo', q: 1 },
          { intent: 'charge', method: 'tempo', q: 0 },
          { intent: '*', method: 'stripe', q: 0.5 },
        ],
        normalized: 'tempo/*, tempo/charge;q=0, stripe/*;q=0.5',
      },
    ] as const

    for (const { entries, header, normalized } of vectors) {
      const parsed = AcceptPayment.parse(header)
      expect(parsed.map(stripIndex)).toEqual(entries)
      expect(AcceptPayment.serialize(parsed)).toBe(normalized)
    }
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

  test('selectChallengeCandidates returns supported offers with methods and response indexes', () => {
    const candidates = AcceptPayment.selectChallengeCandidates(
      [
        { id: '1', intent: 'charge', method: 'unknown', realm: 'test', request: {} },
        { id: '2', intent: 'session', method: 'tempo', realm: 'test', request: {} },
        { id: '3', intent: 'charge', method: 'stripe', realm: 'test', request: {} },
      ],
      [
        { name: 'tempo', intent: 'session' },
        { name: 'stripe', intent: 'charge' },
      ] as const,
      AcceptPayment.parse('stripe/charge;q=0.5, tempo/session;q=0.9'),
    )

    expect(
      candidates.map(({ challenge, index, method }) => ({
        id: challenge.id,
        index,
        key: AcceptPayment.keyOf(method),
      })),
    ).toEqual([
      { id: '2', index: 1, key: 'tempo/session' },
      { id: '3', index: 2, key: 'stripe/charge' },
    ])
  })

  test('selectChallengeCandidates prefers Payment-auth offers before x402 offers', () => {
    const x402Challenge = x402_ChallengeBrand.mark({
      id: 'x402:0',
      intent: 'charge',
      method: 'evm',
      realm: 'test',
      request: { scheme: 'exact' },
    })
    const nativeChallenge = {
      id: 'native',
      intent: 'charge',
      method: 'tempo',
      realm: 'test',
      request: {},
    }

    const candidates = AcceptPayment.selectChallengeCandidates(
      [x402Challenge, nativeChallenge],
      [
        { name: 'evm', intent: 'charge' },
        { name: 'tempo', intent: 'charge' },
      ] as const,
      AcceptPayment.parse('evm/charge, tempo/charge;q=0.5'),
    )

    expect(candidates.map(({ challenge }) => challenge.id)).toEqual(['native', 'x402:0'])
  })

  test('selectChallengeCandidates preserves preference order within Payment-auth offers', () => {
    const candidates = AcceptPayment.selectChallengeCandidates(
      [
        { id: 'tempo', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
        { id: 'evm', intent: 'charge', method: 'evm', realm: 'test', request: {} },
      ],
      [
        { name: 'tempo', intent: 'charge' },
        { name: 'evm', intent: 'charge' },
      ] as const,
      AcceptPayment.parse('evm/charge, tempo/charge;q=0.5'),
    )

    expect(candidates.map(({ challenge }) => challenge.id)).toEqual(['evm', 'tempo'])
  })

  test('selectChallengeCandidates supports duplicate method keys with challenge predicates', () => {
    const challenges = [
      {
        id: 'primary',
        intent: 'session',
        method: 'tempo',
        realm: 'test',
        request: { methodDetails: { sessionProtocol: 'primary' } },
      },
      {
        id: 'fallback',
        intent: 'session',
        method: 'tempo',
        realm: 'test',
        request: { methodDetails: { sessionProtocol: 'fallback' } },
      },
      {
        id: 'unmarked',
        intent: 'session',
        method: 'tempo',
        realm: 'test',
        request: {},
      },
    ]
    const methods = [
      {
        name: 'tempo',
        intent: 'session',
        canHandleChallenge: ({
          challenge,
        }: {
          challenge: AcceptPayment.ChallengeCandidate['challenge']
        }) =>
          (challenge.request.methodDetails as { sessionProtocol?: string } | undefined)
            ?.sessionProtocol === 'primary',
      },
      {
        name: 'tempo',
        intent: 'session',
        canHandleChallenge: ({
          challenge,
        }: {
          challenge: AcceptPayment.ChallengeCandidate['challenge']
        }) => {
          const sessionProtocol = (
            challenge.request.methodDetails as { sessionProtocol?: string } | undefined
          )?.sessionProtocol
          return sessionProtocol === undefined || sessionProtocol === 'fallback'
        },
      },
    ] as const

    const candidates = AcceptPayment.selectChallengeCandidates(
      challenges,
      methods,
      AcceptPayment.parse('tempo/session'),
    )

    expect(candidates.map(({ challenge }) => challenge.id)).toEqual([
      'primary',
      'fallback',
      'unmarked',
    ])
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

describe('preferCandidates', () => {
  const challenge = (id: string) =>
    ({ id, intent: 'charge', method: 'tempo', realm: 'test', request: {} }) as const
  const plain = { name: 'tempo', intent: 'charge' }

  test('moves preferred offers first and keeps the rest in order', async () => {
    const method = AcceptPayment.withPreference(
      { name: 'tempo', intent: 'charge' },
      async ({ challenge }) => challenge.id === '3',
    )
    const candidates = ['1', '2', '3', '4'].map((id) => ({ challenge: challenge(id), method }))
    const ordered = await AcceptPayment.preferCandidates(candidates)
    expect(ordered.map(({ challenge }) => challenge.id)).toEqual(['3', '1', '2', '4'])
  })

  test('keeps the order when nothing is preferred, a preference throws, or a method has none', async () => {
    const declines = AcceptPayment.withPreference({ ...plain }, async () => false)
    const throws = AcceptPayment.withPreference({ ...plain }, async () => {
      throw new Error('rpc down')
    })
    const candidates = [
      { challenge: challenge('1'), method: plain },
      { challenge: challenge('2'), method: declines },
      { challenge: challenge('3'), method: throws },
    ]
    expect(await AcceptPayment.preferCandidates(candidates)).toBe(candidates)
  })

  test('passes every offer and the caller context, but not the deferred marker', async () => {
    const seen: unknown[] = []
    const method = AcceptPayment.withPreference({ ...plain }, async (parameters) => {
      seen.push(parameters)
      return false
    })
    const candidates = [
      { challenge: challenge('1'), method },
      { challenge: challenge('2'), method },
    ]
    await AcceptPayment.preferCandidates(candidates, { account: 'a' })
    await AcceptPayment.preferCandidates(candidates, AcceptPayment.deferredContext)
    expect(seen[0]).toMatchObject({ context: { account: 'a' } })
    expect((seen[0] as { challenges: unknown[] }).challenges).toHaveLength(2)
    expect(seen[2]).not.toHaveProperty('context')
  })

  test('never moves an offer ahead of another capability', async () => {
    const tempo = AcceptPayment.withPreference(
      { ...plain },
      async ({ challenge }) => challenge.id === 'mach',
    )
    const stripe = { name: 'stripe', intent: 'charge' }
    const ordered = await AcceptPayment.preferCandidates([
      {
        challenge: { id: 'card', intent: 'charge', method: 'stripe', realm: 'test', request: {} },
        method: stripe,
      },
      { challenge: challenge('usd'), method: tempo },
      { challenge: challenge('mach'), method: tempo },
    ])
    expect(ordered.map(({ challenge }) => challenge.id)).toEqual(['card', 'mach', 'usd'])
  })

  test('never prefers an expired offer', async () => {
    const method = AcceptPayment.withPreference({ ...plain }, async () => true)
    const expired = { ...challenge('2'), expires: new Date(Date.now() - 1_000).toISOString() }
    const candidates = [
      { challenge: challenge('1'), method: plain },
      { challenge: expired, method },
    ]
    expect(await AcceptPayment.preferCandidates(candidates)).toBe(candidates)
  })

  test('survives spreading the method', async () => {
    const method = AcceptPayment.withPreference({ ...plain }, async () => true)
    const spread = { ...method }
    const ordered = await AcceptPayment.preferCandidates([
      { challenge: challenge('1'), method: plain },
      { challenge: challenge('2'), method: spread },
    ])
    expect(ordered.map(({ challenge }) => challenge.id)).toEqual(['2', '1'])
  })
})
