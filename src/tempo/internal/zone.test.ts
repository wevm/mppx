import { describe, expect, test } from 'vp/test'

import * as Zone from './zone.js'

describe('Zone', () => {
  test('idFromChainId', () => {
    expect(Zone.idFromChainId(421_700_003)).toBe(3)
    expect(Zone.idFromChainId(1_424_310_003)).toBe(3)
    expect(Zone.idFromChainId(1337 * 2 ** 32 + 1)).toBe(1)
    expect(() => Zone.idFromChainId(42_431)).toThrow('Cannot derive a Zone ID')
  })

  test('portalAddress', () => {
    expect(Zone.portalAddress(3)).toBe('0x5ad0000000000000000000000000000000000003')
  })
})
