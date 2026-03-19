/**
 * Duck-typed interface for the Whop SDK (@whop/sdk).
 * Matches the subset used by mppx for server-side payment verification
 * and checkout configuration creation.
 *
 * Uses loose signatures so any Whop SDK version is assignable.
 */
export type WhopClient = {
  payments: {
    retrieve(id: string): Promise<WhopPayment>
  }
  checkoutConfigurations: {
    create(...args: any[]): Promise<WhopCheckoutConfig>
  }
}

export type WhopPayment = {
  id: string
  status: string
  total: number
  subtotal: number
  currency: string
}

export type WhopCheckoutConfig = {
  id: string
  purchase_url: string
}
