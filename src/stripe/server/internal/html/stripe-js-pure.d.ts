declare module '@stripe/stripe-js/pure' {
  export * from '@stripe/stripe-js'

  export const loadStripe: typeof import('@stripe/stripe-js').loadStripe & {
    setLoadParameters(parameters: { advancedFraudSignals: boolean }): void
  }
}
