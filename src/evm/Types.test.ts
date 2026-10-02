import { describe, expect, test } from 'vp/test'

import { challengeHash } from './Types.js'

describe('challengeHash', () => {
  test('frames the challenge id and realm as distinct values', () => {
    expect(challengeHash({ id: 'ab', realm: 'c' })).not.toBe(
      challengeHash({ id: 'a', realm: 'bc' }),
    )
  })

  test('matches the framed hash vector', () => {
    expect(challengeHash({ id: 'challenge', realm: 'example.com' })).toBe(
      '0xaf46a6d4bdf4f9796c81e5d99101e1393b95168c0273f9387b3e45526b09614c',
    )
  })
})
