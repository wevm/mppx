import * as StripeJsTypes from '../../stripe/server/internal/html/types.js'

/**
 * Duck-typed interface for the Stripe Node SDK (`stripe` npm package).
 * Matches the subset of the API used by mppx for server-side payment verification.
 *
 * Uses loose signatures so any Stripe SDK version is assignable.
 */
export type StripeClient = {
  paymentIntents: {
    create(...args: any[]): Promise<{
      id: string
      status: string
      lastResponse?: { headers?: Record<string, string> }
    }>
  }
}

/**
 * Duck-typed interface for Stripe.js (`@stripe/stripe-js`).
 * Matches the subset of the API used by mppx for client-side payment method creation.
 *
 * Uses loose signatures so any Stripe.js version is assignable.
 */
export type StripeJs = {
  createPaymentMethod(...args: any[]): Promise<Record<string, unknown>>
  elements(...args: any[]): unknown
}

export type CreatePaymentMethodFromElements = Omit<
  StripeJsTypes.CreatePaymentMethodFromElements,
  'elements'
> & {}

export type StripeElementsOptionsMode = Omit<
  Extract<StripeJsTypes.StripeElementsOptionsMode, { mode: 'payment' }>,
  | 'amount'
  | 'currency'
  | 'mode'
  | 'excludedPaymentMethodTypes'
  | 'paymentMethodCreation'
  | 'paymentMethodTypes'
  | 'payment_method_types'
> & {}

export type StripePaymentElementOptions = StripeJsTypes.StripePaymentElementOptions
