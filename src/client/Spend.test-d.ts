import { usdc } from 'viem/tokens'
import { describe, expectTypeOf, test } from 'vp/test'

import * as Budget from './Budget.js'
import * as Mppx from './Mppx.js'
import type * as Spend from './Spend.js'

describe('spending options', () => {
  test('Mppx.create accepts maxPayment, authorize, funders and tokens', () => {
    const budget = Budget.create({ total: { value: '5', currency: 'USD' } })
    Mppx.create({
      authorize: budget,
      funders: [{ fund: async (_requirement: Spend.Requirement, _context: Spend.Context) => {} }],
      maxPayment: { value: '1', currency: 'USD' },
      methods: [],
      polyfill: false,
      tokens: [usdc, usdc(8453)],
    })
    Mppx.create({
      maxPayment: [{ network: 'eip155:4217', asset: '0x20c0', amount: 1n }],
      methods: [],
      polyfill: false,
    })
    // @ts-expect-error per-asset amounts are atomic bigints
    Mppx.create({ maxPayment: [{ network: 'stripe', asset: 'usd', amount: 1 }], methods: [] })
  })

  test('Budget amounts follow the total', () => {
    const usd = Budget.create({ total: { value: '5', currency: 'USD' } })
    expectTypeOf(usd.remaining()).toEqualTypeOf<Spend.Money>()
    const asset = Budget.create({ total: { network: 'stripe', asset: 'usd', amount: 500n } })
    expectTypeOf(asset.spent()).toEqualTypeOf<Spend.AssetLimit>()
    expectTypeOf(asset).toMatchTypeOf<Spend.Authorize>()
  })
})
