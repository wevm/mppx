import type { Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import type * as Challenge from '../../Challenge.js'
import {
  resolveAllowCustomEscrow,
  resolveSessionMaxDeposit,
  resolveSessionSelection,
} from './request.js'

const channelId = `0x${'12'.repeat(32)}` as Hex
describe('resolveSessionSelection', () => {
  test('uses auto by default and accepts new or an explicit channel', () => {
    expect(resolveSessionSelection('auto', undefined)).toBe('auto')
    expect(resolveSessionSelection('new', undefined)).toBe('new')
    expect(resolveSessionSelection(channelId.toUpperCase().replace('0X', '0x'), undefined)).toBe(
      channelId,
    )
  })

  test('supports the channel method compatibility alias', () => {
    expect(resolveSessionSelection('auto', channelId)).toBe(channelId)
    expect(resolveSessionSelection(channelId, channelId)).toBe(channelId)
  })

  test('rejects conflicting selectors', () => {
    expect(() => resolveSessionSelection('new', channelId)).toThrow(
      '--session and -M channel= select different sessions.',
    )
  })
})

describe('resolveAllowCustomEscrow', () => {
  test('accepts boolean method options', () => {
    expect(resolveAllowCustomEscrow({ allowCustomEscrow: 'true' })).toBe(true)
    expect(resolveAllowCustomEscrow({ allowCustomEscrow: 'false' })).toBe(false)
    expect(resolveAllowCustomEscrow({})).toBeUndefined()
  })

  test('rejects an invalid boolean', () => {
    expect(() => resolveAllowCustomEscrow({ allowCustomEscrow: 'yes' })).toThrow(
      'allowCustomEscrow must be true or false.',
    )
  })
})

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
