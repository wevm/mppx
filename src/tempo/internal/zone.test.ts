import { describe, expect, test } from 'vp/test'

import * as Zone from './zone.js'

describe('Zone', () => {
  test('idFromChainId', () => {
    expect(Zone.idFromChainId(421_700_003)).toBe(3)
    expect(Zone.idFromChainId(1_424_310_003)).toBe(3)
    expect(Zone.idFromChainId(1337 * 2 ** 32 + 1)).toBe(1)
    expect(() => Zone.idFromChainId(42_431)).toThrow('Cannot derive a Zone ID')
  })

  test('parentChainIdFromChainId', () => {
    expect(Zone.parentChainIdFromChainId(421_700_003)).toBe(4_217)
    expect(Zone.parentChainIdFromChainId(1_424_310_003)).toBe(42_431)
    expect(Zone.parentChainIdFromChainId(1337 * 2 ** 32 + 1)).toBe(1337)
    expect(Zone.parentChainIdFromChainId(42_431)).toBeUndefined()
  })

  test('isId', () => {
    expect(Zone.isId(3)).toBe(true)
    expect(Zone.isId(421_699_999)).toBe(true)
    // viem would read this as Zone 5's chain ID and return Zone 5's portal.
    expect(Zone.isId(421_700_005)).toBe(false)
    expect(Zone.isId(0)).toBe(false)
  })

  test('portalAddress', () => {
    expect(Zone.portalAddress(3)).toBe('0x5ad0000000000000000000000000000000000003')
  })
})
