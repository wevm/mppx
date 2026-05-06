import { describe, expect, test } from 'vp/test'

import * as Charge from './charge.js'

describe('challengeHash', () => {
  test('is deterministic and bytes32-shaped', () => {
    const hash = Charge.challengeHash({ id: 'abc', realm: 'api.example.com' })
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(hash).toBe(Charge.challengeHash({ id: 'abc', realm: 'api.example.com' }))
    expect(hash).not.toBe(Charge.challengeHash({ id: 'def', realm: 'api.example.com' }))
  })
})

describe('getTransfers', () => {
  test('returns primary remainder followed by splits', () => {
    expect(
      Charge.getTransfers({
        amount: '1050000',
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        methodDetails: {
          splits: [
            {
              amount: '50000',
              recipient: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72',
            },
          ],
        },
      }),
    ).toEqual([
      {
        amount: '1000000',
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      },
      {
        amount: '50000',
        recipient: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72',
      },
    ])
  })
})
