import { describe, expect, test } from 'vp/test'

import { mach } from './Tokens.js'

describe('mach', () => {
  test('defines the Moderato MACH currency', () => {
    expect(mach(42431)).toEqual({
      address: '0x20c000000000000000000000f37de3740ADec032',
      currency: 'USD',
      decimals: 6,
      name: 'MACH',
      popular: undefined,
      symbol: 'MACH',
    })
  })
})
