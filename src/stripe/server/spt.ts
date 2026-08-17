import { charge } from './Charge.js'

export { charge }

/** Stripe Shared Payment Token server methods without chain payment rails. */
export const stripe = {
  charge,
  spt: charge,
} as const
