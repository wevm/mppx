import { describe, expect, test } from 'vp/test'

import { getDeployment } from './MachineToken.js'

describe('getDeployment', () => {
  test('returns the mainnet MACH deployment', () => {
    expect(getDeployment(4217)).toEqual({
      swapper: '0xF72E5107c32C655ffA7539a3C8e97B7C3cE16A3F',
      token: '0x20c000000000000000000000f37de3740ADec032',
    })
  })

  test('returns the Moderato MACH deployment', () => {
    expect(getDeployment(42431)).toEqual({
      swapper: '0xd05f8EdFBB54Da0d765C9fE9b2B3f7d2E3a8C466',
      token: '0x20c000000000000000000000f37de3740ADec032',
    })
  })

  test.each([undefined, 1])('returns undefined for unsupported chain %s', (chainId) => {
    expect(getDeployment(chainId)).toBeUndefined()
  })
})
