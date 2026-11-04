/**
 * Duck-typed interface for the Stripe Node SDK (`stripe` npm package).
 * Matches the subset of the API used by mppx for server-side payment verification.
 *
 * Uses loose signatures so any Stripe SDK version is assignable.
 */
export type StripeClient = {
  /** Stripe-node request transport used for hosted fee-payer requests. */
  _requestSender?:
    | {
        _request(...args: any[]): void
      }
    | undefined
  paymentIntents: {
    create(...args: any[]): Promise<{
      id: string
      status: string
      lastResponse?: { headers?: Record<string, string> }
    }>
  }
  rawRequest?(method: string, path: string, params?: any, options?: any): Promise<any>
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

/** A nested Stripe.js option object, passed through to Stripe.js as is. */
type StripeJsObject = { readonly [key: string]: any }

/**
 * Stripe.js Elements appearance (`Appearance` in `@stripe/stripe-js`).
 *
 * @see https://docs.stripe.com/elements/appearance-api
 */
export type StripeAppearance = {
  disableAnimations?: boolean | undefined
  theme?: 'stripe' | 'night' | 'flat' | undefined
  variables?: StripeJsObject | undefined
  rules?: StripeJsObject | undefined
  labels?: 'auto' | 'above' | 'floating' | undefined
  inputs?: 'spaced' | 'condensed' | undefined
}

/**
 * Options for `stripe.createPaymentMethod` with Elements, without `elements`
 * (`CreatePaymentMethodFromElements` in `@stripe/stripe-js`).
 *
 * Structural so mppx's types don't depend on `@stripe/stripe-js`; its values stay assignable.
 */
export type CreatePaymentMethodFromElements = {
  /** Payment method parameters (`PaymentMethodCreateParams`). */
  params?: StripeJsObject | undefined
  metadata?: { readonly [name: string]: string | number | null } | undefined
}

/**
 * Options for `stripe.elements` in payment mode, without the fields mppx sets from the
 * Challenge (`StripeElementsOptionsMode` in `@stripe/stripe-js`).
 *
 * Structural so mppx's types don't depend on `@stripe/stripe-js`; its values stay assignable.
 */
export type StripeElementsOptionsMode = {
  adaptivePricing?: { allowed?: boolean | undefined } | undefined
  allowedPaymentMethodTypes?: readonly string[] | undefined
  appearance?: StripeAppearance | undefined
  captureMethod?: 'manual' | 'automatic' | 'automatic_async' | undefined
  capture_method?: 'manual' | 'automatic' | 'automatic_async' | undefined
  clientSecret?: undefined
  customPaymentMethods?: readonly StripeJsObject[] | undefined
  customerOptions?: StripeJsObject | undefined
  customerSessionClientSecret?: string | undefined
  externalPaymentMethodTypes?: readonly string[] | undefined
  fonts?: readonly StripeJsObject[] | undefined
  loader?: 'auto' | 'always' | 'never' | undefined
  locale?: string | undefined
  onBehalfOf?: string | undefined
  on_behalf_of?: string | undefined
  paymentMethodConfiguration?: string | undefined
  payment_method_configuration?: string | undefined
  paymentMethodOptions?: StripeJsObject | undefined
  payment_method_options?: StripeJsObject | undefined
  setupFutureUsage?: 'off_session' | 'on_session' | null | undefined
  setup_future_usage?: 'off_session' | 'on_session' | null | undefined
  syncAddressCheckbox?: 'billing' | 'shipping' | 'none' | undefined
}

/**
 * Options for the Stripe.js Payment Element (`StripePaymentElementOptions` in `@stripe/stripe-js`).
 *
 * Structural so mppx's types don't depend on `@stripe/stripe-js`; its values stay assignable.
 */
export type StripePaymentElementOptions = {
  applePay?: StripeJsObject | undefined
  business?: { name: string } | undefined
  defaultValues?: StripeJsObject | undefined
  fields?: StripeJsObject | undefined
  layout?: string | StripeJsObject | undefined
  paymentMethodOrder?: readonly string[] | undefined
  readOnly?: boolean | undefined
  terms?: StripeJsObject | undefined
  walletOptions?: StripeJsObject | undefined
  wallets?: StripeJsObject | undefined
}
