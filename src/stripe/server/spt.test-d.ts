import { charge, stripe } from 'mppx/stripe/server/spt'
import { expectTypeOf, test } from 'vp/test'

test('exports typed Stripe SPT constructors', () => {
  expectTypeOf(stripe.spt).toEqualTypeOf(charge)
  expectTypeOf(stripe.charge).toEqualTypeOf(charge)
})
