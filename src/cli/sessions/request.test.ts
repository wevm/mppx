import { describe, expect, test } from 'vp/test'

import type * as Challenge from '../../Challenge.js'
import { resolveSessionMaxDeposit } from './request.js'

describe('resolveSessionMaxDeposit', () => {
  const challenge = {
    id: 'challenge-1',
    realm: 'api.example.test',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1000000',
      currency: '0x3333333333333333333333333333333333333333',
      decimals: 6,
      recipient: '0x2222222222222222222222222222222222222222',
      suggestedDeposit: '7000000',
    },
  } satisfies Challenge.Challenge

  test('converts the raw server suggestion to human-readable token units', () => {
    expect(resolveSessionMaxDeposit(challenge, {}, false)).toBe('7')
  })

  test('prefers the human-readable CLI deposit override', () => {
    expect(resolveSessionMaxDeposit(challenge, { deposit: '10' }, false)).toBe('10')
  })
})
