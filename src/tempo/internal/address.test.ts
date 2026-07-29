import { TempoAddress } from 'ox/tempo'
import { describe, expect, test } from 'vp/test'

import { isEqual } from './address.js'

const address = '0x742d35Cc6634C0532925a3b844Bc9e7595F2bD28'
const otherAddress = '0x52908400098527886E0F7030069857D2E4169EE7'

describe('isEqual', () => {
  const representations = [
    { name: 'mixed-case hex', value: address },
    { name: 'lowercase hex', value: address.toLowerCase() as `0x${string}` },
    { name: 'Tempo-formatted', value: TempoAddress.format(address) },
  ] as const

  const otherRepresentations = [
    { name: 'mixed-case hex', value: otherAddress },
    { name: 'lowercase hex', value: otherAddress.toLowerCase() as `0x${string}` },
    { name: 'Tempo-formatted', value: TempoAddress.format(otherAddress) },
  ] as const

  test.each([
    ...representations.flatMap((a) =>
      representations.map((b) => ({
        a: a.value,
        b: b.value,
        expected: true,
        name: `${a.name} and ${b.name} representations of the same address`,
      })),
    ),
    ...representations.flatMap((a) =>
      otherRepresentations.map((b) => ({
        a: a.value,
        b: b.value,
        expected: false,
        name: `${a.name} and ${b.name} representations of different addresses`,
      })),
    ),
  ])('$name', ({ a, b, expected }) => {
    expect(isEqual(a, b)).toBe(expected)
  })
})
