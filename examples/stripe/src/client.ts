// mpay Stripe SPT Charge — Client Example (Browser)

//
// This example demonstrates the manual HTTP 402 payment flow with Stripe:
//
//   1. Request a paid resource → server returns 402 + WWW-Authenticate challenge
//   2. Parse the challenge to extract payment parameters (amount, currency, networkId)
//   3. Collect card details via Stripe.js Elements (or use a test card shortcut)
//   4. Create a Shared Payment Token (SPT) via the server proxy
//   5. Retry the request with an Authorization: Payment <credential> header
//   6. Server verifies the SPT by creating a Stripe PaymentIntent → returns 200 + receipt
//
// This is a MANUAL flow — each step is shown in a terminal-style log so you
// can see exactly what happens at each stage of the 402 protocol. In production,
// you'd use `Mpay.create()` with `mpay.fetch()` to handle this automatically.
//
// NOTE: SPT creation is proxied through `/api/create-spt` on the server because
// the Stripe API doesn't support browser CORS. In production, you'd use Stripe.js
// or a backend-for-frontend pattern.
//

// `loadStripe` initializes Stripe.js, which provides Elements (secure card input)
// and payment method creation. The publishable key identifies your Stripe account
// but can't be used to charge — that requires the secret key on the server.
import { loadStripe } from '@stripe/stripe-js'

// `Challenge` parses the WWW-Authenticate header from a 402 response.
// `Credential` serializes the payment proof (SPT) into the Authorization header.
// `Receipt` parses the Payment-Receipt header from the 200 response.
import { Challenge, Credential, Receipt } from 'mpay'

const publishableKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY as string

// Initialize Stripe.js and mount a Card Element.
// The Card Element is a pre-built, PCI-compliant input that collects card number,
// expiry, and CVC. Stripe.js tokenizes the card details into a PaymentMethod ID
// (e.g. `pm_1Q...`) — the raw card number never touches your server.
const stripe = (await loadStripe(publishableKey))!
const elements = stripe.elements()
const card = elements.create('card')
card.mount('#card-element')

// DOM references
const requestBtn = document.getElementById('request')!
const cardForm = document.getElementById('card-form')!
const payBtn = document.getElementById('pay')!
const testCardBtn = document.getElementById('test-card')!
const fortuneEl = document.getElementById('fortune')!
const output = document.getElementById('output')!

// The pending challenge from the server's 402 response. This is set after
// the first request and consumed when the user submits payment.
let pendingChallenge: ReturnType<typeof Challenge.fromResponse> | null = null

// Click-to-copy for test card details (card number, expiry, CVC, zip).
for (const el of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(el.dataset.copy!)
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 600)
  })
}

// Step 1: Request the paid resource
//
// Send a plain GET request with no credentials. The server will respond with
// 402 Payment Required and a WWW-Authenticate header containing the challenge.
//
// The challenge is a base64url-encoded JSON object with:
//   - id: HMAC-SHA256 binding the challenge to its parameters (prevents tampering)
//   - realm: server identity (e.g. 'api.example.com')
//   - method: 'stripe'
//   - intent: 'charge'
//   - request: { amount: '100', currency: 'usd', methodDetails: { networkId: '...' } }
//
// We parse the challenge and display its fields in the terminal log, then show
// the card form so the user can enter payment details.
requestBtn.addEventListener('click', async () => {
  requestBtn.setAttribute('disabled', '')
  output.textContent = ''
  fortuneEl.textContent = ''
  cardForm.style.display = 'none'

  log('$ curl https://api.example.com/fortune', 'status')
  log('')

  const response = await fetch('/api/fortune')
  log(`HTTP/${response.status} ${response.statusText}`)

  if (response.status !== 402) {
    log('Expected 402 Payment Required', 'error')
    requestBtn.removeAttribute('disabled')
    return
  }

  // Parse the WWW-Authenticate header to extract the challenge.
  // `Challenge.fromResponse()` decodes the base64url JSON and validates
  // the challenge structure (id, realm, method, intent, request).
  const wwwAuth = response.headers.get('WWW-Authenticate')!
  log(`WWW-Authenticate: ${wwwAuth}`)
  log('')

  pendingChallenge = Challenge.fromResponse(response)
  log(`→ method: ${pendingChallenge.method}`)
  log(`→ intent: ${pendingChallenge.intent}`)
  log(`→ amount: ${pendingChallenge.request.amount} (base units)`)
  log(`→ currency: ${pendingChallenge.request.currency}`)
  log('')
  log('Payment required. Enter card details to create an SPT.', 'status')

  cardForm.style.display = 'block'
  requestBtn.style.display = 'none'
})

// Step 2a: "Autofill" shortcut — use Stripe's test card directly
//
// `pm_card_visa` is a special Stripe test payment method that always succeeds.
// This bypasses the Card Element entirely, useful for quick testing.
testCardBtn.addEventListener('click', () => submitPayment('pm_card_visa'))

// Step 2b: Real card flow — create a PaymentMethod from the Card Element
//
// `stripe.createPaymentMethod()` tokenizes the card details entered in the
// Card Element into a PaymentMethod ID. This ID is then used to create an SPT.
payBtn.addEventListener('click', async () => {
  if (!pendingChallenge) return
  payBtn.setAttribute('disabled', '')

  log('')
  log('Creating payment method via Stripe.js...')
  const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
    type: 'card',
    card,
  })
  if (pmError || !paymentMethod) {
    log(`Error: ${pmError?.message ?? 'No payment method'}`, 'error')
    payBtn.removeAttribute('disabled')
    return
  }
  log(`PaymentMethod: ${paymentMethod.id}`)

  await submitPayment(paymentMethod.id)
})

// Step 3: Create SPT and submit credential
//
// This function handles the core payment flow:
//
//   1. Create an SPT via the server proxy (`/api/create-spt`), which calls
//      Stripe's test helper endpoint. The SPT is a single-use token (prefixed
//      `spt_`) that authorizes the server to charge up to the specified amount.
//
//   2. Build the credential by serializing the challenge + SPT payload into
//      base64url JSON. The credential echoes back the original challenge so
//      the server can verify it via HMAC, plus the `payload: { spt }` which
//      is the Stripe-specific proof of payment.
//
//   3. Retry the original request with `Authorization: Payment <credential>`.
//      The server extracts the SPT from the credential, creates a Stripe
//      PaymentIntent with `shared_payment_granted_token: spt` and `confirm: true`,
//      and if the PaymentIntent succeeds, returns 200 with the fortune.
//
//   4. Parse the `Payment-Receipt` header from the response. The receipt contains
//      the Stripe PaymentIntent ID as the `reference` (e.g. `pi_3Q...`), which
//      can be used for reconciliation, refunds, or dispute resolution.
//
async function submitPayment(paymentMethodId: string) {
  if (!pendingChallenge) return
  payBtn.setAttribute('disabled', '')
  testCardBtn.setAttribute('disabled', '')

  if (paymentMethodId === 'pm_card_visa') {
    log('')
    log('Using test card (pm_card_visa)...')
  }

  log('Creating SPT...')
  try {
    const spt = await createSpt({
      paymentMethod: paymentMethodId,
      amount: pendingChallenge.request.amount as string,
      currency: pendingChallenge.request.currency as string,
      networkId: (pendingChallenge.request.methodDetails as { networkId?: string })?.networkId,
    })
    log(`SPT: ${spt}`)

    cardForm.style.display = 'none'

    // Build the credential: base64url({ challenge, payload: { spt } })
    // The `challenge` is echoed back so the server can recompute the HMAC
    // and verify the credential is bound to the original challenge.
    log('')
    log('Retrying with credential...', 'status')
    const credential = Credential.serialize({
      challenge: pendingChallenge,
      payload: { spt },
    })
    log(`Authorization: Payment ${credential.slice(0, 40)}...`)

    const paid = await fetch('/api/fortune', {
      headers: { Authorization: credential },
    })

    log('')
    log(`HTTP/${paid.status} ${paid.statusText}`)

    if (!paid.ok) {
      log(`Payment failed: ${paid.status}`, 'error')
      payBtn.removeAttribute('disabled')
      return
    }

    // Parse the Payment-Receipt header. The receipt is a base64url-encoded
    // JSON object with:
    //   - status: 'success'
    //   - method: 'stripe'
    //   - timestamp: ISO 8601
    //   - reference: Stripe PaymentIntent ID (e.g. `pi_3Q...`)
    const receipt = Receipt.fromResponse(paid)
    const { fortune } = (await paid.json()) as { fortune: string }

    log(`Payment-Receipt: ${receipt.reference}`)
    log('')
    log(`✓ ${fortune}`, 'done')
    log(`✓ Receipt: ${receipt.method} / ${receipt.status} / ${receipt.reference}`, 'done')

    fortuneEl.textContent = fortune
    pendingChallenge = null
  } catch (err) {
    log(String(err), 'error')
    payBtn.removeAttribute('disabled')
    testCardBtn.removeAttribute('disabled')
  }
}

////////////////////////////////////////////////////////////////////
// Internal

// Simple terminal-style logger that appends styled lines to the output div.
function log(msg: string, cls = 'step') {
  const line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  output.appendChild(line)
}

// Proxy SPT creation through the server.
//
// The browser can't call the Stripe API directly (no CORS headers), so we
// proxy through `/api/create-spt`. In production, you'd create SPTs via:
//   - Stripe.js: `stripe.sharedPayment.issuedTokens.create({ ... })`
//   - Or a backend-for-frontend that calls Stripe's issued_tokens endpoint
//
// The SPT is constrained by usage limits:
//   - `currency`: must match the challenge currency
//   - `max_amount`: maximum amount the SPT can be used for (in base units)
//   - `expires_at`: Unix timestamp after which the SPT is invalid
async function createSpt(params: {
  paymentMethod: string
  amount: string
  currency: string
  networkId?: string
}) {
  const response = await fetch('/api/create-spt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } }
    throw new Error(`SPT creation failed: ${error.error.message}`)
  }

  const { id } = (await response.json()) as { id: string }
  return id
}
