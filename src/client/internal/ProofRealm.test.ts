import { describe, expect, test } from 'vp/test'

import type * as Challenge from '../../Challenge.js'
import * as ProofRealm from './ProofRealm.js'

const url = new URL('https://attacker.example/resource')

function challenge(overrides: Partial<Challenge.Challenge> = {}): Challenge.Challenge {
  return {
    id: 'id',
    intent: 'charge',
    method: 'tempo',
    realm: 'target.example',
    request: { amount: '0' },
    ...overrides,
  } as Challenge.Challenge
}

describe('assert', () => {
  test.each([
    { name: 'nonzero amount', challenge: challenge({ request: { amount: '1' } }) },
    { name: 'non-numeric amount', challenge: challenge({ request: { amount: 'x' } }) },
    { name: 'missing amount', challenge: challenge({ request: {} }) },
    { name: 'non-tempo method', challenge: challenge({ method: 'stripe' }) },
    { name: 'non-charge intent', challenge: challenge({ intent: 'session' }) },
    { name: 'matching hostname', challenge: challenge({ realm: 'Attacker.Example' }) },
  ])('ignores $name', ({ challenge }) => {
    expect(() => ProofRealm.assert(challenge, url, undefined)).not.toThrow()
  })

  test.each([
    { name: 'without pins', trustedRealms: undefined },
    {
      name: 'pinned to another origin',
      trustedRealms: { 'https://api.example': 'target.example' },
    },
    { name: 'with another realm pinned', trustedRealms: { 'https://attacker.example': 'other' } },
  ])('rejects a foreign realm $name', ({ trustedRealms }) => {
    expect(() => ProofRealm.assert(challenge(), url, trustedRealms)).toThrow(
      'Refusing to sign Tempo proof for realm "target.example" from https://attacker.example',
    )
  })

  test.each<unknown>(['0x0', ' 0 ', '-0', '00', false, [], ['0']])(
    'rejects a foreign realm with amount %j',
    (amount) => {
      expect(() => ProofRealm.assert(challenge({ request: { amount } }), url, undefined)).toThrow(
        'Refusing to sign Tempo proof for realm',
      )
    },
  )

  test('accepts a realm pinned to the origin', () => {
    expect(() =>
      ProofRealm.assert(challenge(), url, { 'https://Attacker.example/': 'target.example' }),
    ).not.toThrow()
  })
})

describe('assertWithoutOrigin', () => {
  test('ignores a paid challenge', () => {
    expect(() =>
      ProofRealm.assertWithoutOrigin(challenge({ request: { amount: '1' } }), undefined),
    ).not.toThrow()
  })

  test('rejects an unlisted realm', () => {
    expect(() => ProofRealm.assertWithoutOrigin(challenge(), ['other.example'])).toThrow(
      'Refusing to sign Tempo proof for untrusted realm "target.example"',
    )
  })

  test('accepts a listed realm', () => {
    expect(() => ProofRealm.assertWithoutOrigin(challenge(), ['target.example'])).not.toThrow()
  })
})
