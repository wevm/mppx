import { charge, stripe } from 'mppx/stripe/server/spt'
import { expect, test } from 'vp/test'

test('exports only Stripe SPT server methods', () => {
  expect(stripe.spt).toBe(charge)
  expect(stripe.charge).toBe(charge)
  expect(stripe).not.toHaveProperty('create')
})
