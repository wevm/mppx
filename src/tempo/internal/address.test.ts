import { TempoAddress } from 'ox/tempo'
import { describe, expect, test } from 'vp/test'

import { isEqual } from './address.js'

const address = '0x742d35Cc6634C0532925a3b844Bc9e7595F2bD28'

describe('isEqual', () => {
  test('compares hex addresses case-insensitively', () => {
    expect(isEqual(address, address.toLowerCase() as `0x${string}`)).toBe(true)
  })

  test('treats equivalent hex and Tempo addresses as equal', () => {
    expect(isEqual(address, TempoAddress.format(address))).toBe(true)
  })

  test('rejects different addresses', () => {
    expect(isEqual(address, '0x0000000000000000000000000000000000000001')).toBe(false)
  })
})
