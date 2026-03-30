/**
 * Duck-typed interface for the Stripe Node SDK (`stripe` npm package).
 * Matches the subset of the API used by mppx for server-side payment verification
 * and HTML test-helper SPT creation.
 *
 * Uses loose signatures so any Stripe SDK version is assignable.
 */
export type StripeClient = {
  paymentIntents: {
    create(...args: any[]): Promise<{
      id: string
      status: string
      latest_charge?: { outcome?: { risk_level?: string } } | string | null
      lastResponse?: { headers?: Record<string, string> }
    }>
  }
  rawRequest?: (...args: any[]) => Promise<Record<string, unknown>>
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
