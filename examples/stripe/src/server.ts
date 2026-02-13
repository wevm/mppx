// mpay Stripe SPT Charge — Server Example

//
// This server demonstrates the HTTP 402 payment flow using Stripe Shared
// Payment Tokens (SPTs). It exposes two endpoints:
//
//   /api/fortune — A payment-gated endpoint that costs $1.00 USD.
//     1. CHALLENGE: When a request arrives without credentials, return 402 with
//        a WWW-Authenticate header containing the payment challenge (amount,
//        currency, Stripe Business Network Profile ID).
//     2. VERIFY: When the client retries with an Authorization header containing
//        an SPT credential, the server creates a Stripe PaymentIntent using the
//        SPT's `shared_payment_granted_token` parameter and confirms it. If the
//        PaymentIntent succeeds, return 200 with a Payment-Receipt header.
//
//   /api/create-spt — A proxy endpoint for SPT creation.
//     The browser can't call the Stripe API directly (no CORS), so this endpoint
//     proxies the client's SPT creation request to Stripe's test helper endpoint.
//     In production, the client would use Stripe.js or a backend-for-frontend
//     pattern instead.
//

// `Mpay` is the server-side payment handler that manages challenges, credential
// verification, and receipt generation. `stripe` provides the Stripe-specific
// charge payment method using SPTs.
import { Mpay, stripe } from 'mpay/server'

// Stripe secret key from environment. Used for both:
//   1. Creating PaymentIntents on the server (settlement)
//   2. Proxying SPT creation requests from the browser (test helper)
const secretKey = process.env.VITE_STRIPE_SECRET_KEY!

// Stripe test helper endpoint for creating SPTs. In production, clients create
// SPTs via `POST /v1/shared_payment/issued_tokens` with `seller_details`. The
// test helper endpoint (`granted_tokens`) skips seller verification, making it
// easier to test without a full Business Network Profile setup.
const sptUrl = 'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens'

// Payment handler setup
//
// `Mpay.create()` builds a payment handler from one or more payment methods.
// Each method defines how challenges are issued, credentials are verified,
// and receipts are generated.
//
// `stripe.charge()` creates a one-time charge method that:
//   - Issues 402 challenges with `networkId` in `methodDetails`
//   - Verifies SPT credentials by creating a Stripe PaymentIntent with
//     `shared_payment_granted_token` and `confirm: true`
//   - Returns a receipt with the PaymentIntent ID as the reference
//
// Configuration:
//   - `secretKey`: Stripe secret API key for PaymentIntent creation
//   - `networkId`: Stripe Business Network Profile ID. Included in the
//     challenge so the client knows which network to create the SPT for.
//     The server also sends it as `metadata[network_id]` on the PaymentIntent.
const mpay = Mpay.create({
  methods: [stripe.charge({ secretKey, networkId: 'profile_test' })],
})

const fortunes = [
  'A beautiful, smart, and loving person will come into your life.',
  'A dubious friend may be an enemy in camouflage.',
  'A faithful friend is a strong defense.',
  'A fresh start will put you on your way.',
  'A golden egg of opportunity falls into your lap this month.',
  'A good time to finish up old tasks.',
  'A hunch is creativity trying to tell you something.',
  'A lifetime of happiness lies ahead of you.',
  'A light heart carries you through all the hard times.',
  'A new perspective will come with the new year.',
]

// Request handler
//
// This is a standard Request → Response handler (works with any framework
// that uses the Fetch API Request/Response types — Bun, Deno, Vite, etc.).
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Paid endpoint — fortune costs $1.00 USD.
  //
  // `mpay.charge()` returns a curried function:
  //   mpay.charge({ amount, currency, decimals }) → (request) → result
  //
  // The first call configures the payment parameters:
  //   - `amount: '1'` — costs 1 USD (in human units)
  //   - `currency: 'usd'` — US dollars
  //   - `decimals: 2` — Stripe uses 2 decimal places (100 = $1.00)
  //     The `amount` is transformed via `parseUnits('1', 2)` → '100' in the
  //     challenge, matching Stripe's smallest currency unit (cents).
  //
  // The second call `(request)` processes the HTTP request:
  //   1. Checks for an Authorization header with a Payment credential
  //   2. If missing: returns { status: 402, challenge } with WWW-Authenticate
  //   3. If present: verifies the SPT by creating a PaymentIntent via Stripe API
  //      and returns { status: 200, withReceipt }
  if (url.pathname === '/api/fortune') {
    const result = await mpay.charge({ amount: '1', currency: 'usd', decimals: 2 })(request)

    // If status is 402, the request had no valid credential.
    // Return the challenge response (402 + WWW-Authenticate header).
    if (result.status === 402) return result.challenge

    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!

    // `result.withReceipt()` wraps the response with a `Payment-Receipt` header.
    // The receipt is a base64url-encoded JSON object containing:
    //   - status: 'success'
    //   - method: 'stripe'
    //   - timestamp: ISO 8601
    //   - reference: the Stripe PaymentIntent ID (e.g. `pi_3Q...`)
    return result.withReceipt(Response.json({ fortune }))
  }

  // SPT creation proxy — browser can't call Stripe API directly (no CORS).
  //
  // The client sends the payment method ID, amount, and currency. This endpoint
  // forwards the request to Stripe's test helper endpoint to create an SPT.
  //
  // In production, SPT creation would happen via:
  //   - Stripe.js in the browser (using `stripe.sharedPayment.issuedTokens.create()`)
  //   - Or a backend-for-frontend that calls `POST /v1/shared_payment/issued_tokens`
  //     with `seller_details[network_id]` set to the server's Business Network Profile ID
  //
  // The test helper endpoint (`granted_tokens`) doesn't require `seller_details`,
  // which simplifies testing.
  if (url.pathname === '/api/create-spt' && request.method === 'POST') {
    const params = await request.json() as {
      paymentMethod: string
      amount: string
      currency: string
      networkId?: string
    }

    // SPT expires in 1 hour. The client should use the SPT before this time.
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const body = new URLSearchParams({
      payment_method: params.paymentMethod,
      'usage_limits[currency]': params.currency,
      'usage_limits[max_amount]': params.amount,
      'usage_limits[expires_at]': expiresAt.toString(),
    })
    const res = await fetch(sptUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${secretKey}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const data = await res.json()
    return Response.json(data, { status: res.status })
  }

  // Return null for unhandled routes (let the framework handle 404s).
  return null
}
