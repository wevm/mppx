import type { Hex } from 'viem'
import { describe, expect, test } from 'vp/test'

import { resolveSessionSelection } from './request.js'

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
