import { stripePreviewVersion } from '../../internal/constants.js'

const SUPPORTED_NETWORKS: Record<string, string> = {
  tempo: 'tempo',
  evm: 'base',
}

/**
 * Records a crypto payment as a Stripe PaymentIntent using transaction_verification mode.
 * Fire-and-forget: errors are logged but never thrown.
 */
export function recordCryptoPayment(parameters: {
  secretKey: string
  method: string
  reference: string
  amount: string
}): void {
  const { secretKey, method, reference, amount } = parameters
  const network = SUPPORTED_NETWORKS[method]
  if (!network) return

  const amountCents = Math.round(parseFloat(amount) * 100)
  if (amountCents < 1) return

  const body = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    confirm: 'true',
    'payment_method_data[type]': 'crypto',
    'payment_method_types[0]': 'crypto',
    'payment_method_options[crypto][mode]': 'transaction_verification',
    'payment_method_options[crypto][transaction_verification_options][network]': network,
    'payment_method_options[crypto][transaction_verification_options][transaction_hash]': reference,
  })

  fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': reference,
      'Stripe-Version': stripePreviewVersion,
    },
    body,
  }).catch((err) => {
    console.error('[stripe] failed to record crypto payment:', err)
  })
}
