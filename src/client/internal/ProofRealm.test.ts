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
    { name: 'without trustedRealms', trustedRealms: undefined },
    { name: 'with unrelated trustedRealms', trustedRealms: ['other.example'] },
  ])('rejects a foreign realm $name', ({ trustedRealms }) => {
    expect(() => ProofRealm.assert(challenge(), url, trustedRealms)).toThrow(
      'Refusing to sign Tempo proof for realm "target.example" from https://attacker.example',
    )
  })

  test('accepts a trusted realm', () => {
    expect(() => ProofRealm.assert(challenge(), url, ['TARGET.example'])).not.toThrow()
  })
})
