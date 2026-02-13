import { loadStripe } from '@stripe/stripe-js'
import { Challenge, Receipt } from 'mpay'
import { stripe } from 'mpay/client'

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY as string
if (!stripePublishableKey) {
  throw new Error('Missing VITE_STRIPE_PUBLIC_KEY')
}

// MPay client for handling stripe charges
const charge = stripe.charge({
  createSpt: async (params) => {
    log('Creating SPT...')
    const response = await fetch('/api/create-spt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    if (!response.ok) throw new Error('Failed to create SPT')
    const { spt } = await response.json()
    log(`SPT: ${spt}`)
    return spt
  },
})

const stripeClient = await loadStripe(stripePublishableKey)
if (!stripeClient) throw new Error('Stripe.js failed to load')

const output = document.getElementById('output')!
const formError = document.getElementById('form-error')
const paymentForm = document.getElementById('payment-form')
const testHelpers = document.getElementById('test-helpers')
const fortuneEl = document.getElementById('fortune')
const actionButton = document.getElementById('button') as HTMLButtonElement | null

function log(message: string) {
  output.textContent += `${output.textContent ? '\n' : ''}${message}`
}

function setFormError(message: string | null) {
  if (!formError) return
  if (!message) {
    formError.textContent = ''
    formError.classList.add('hidden')
    return
  }
  formError.textContent = message
  formError.classList.remove('hidden')
}

const TEST_VALUES = {
  number: '4242 4242 4242 4242',
  exp: '12/34',
  cvc: '123',
}

async function copyText(value: string) {
  const testStatus = document.getElementById('test-status')
  try {
    await navigator.clipboard.writeText(value)
    if (testStatus) testStatus.textContent = 'Copied to clipboard.'
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
    if (testStatus) testStatus.textContent = 'Copied to clipboard.'
  }
}

const copyCard = document.getElementById('copy-card')
const copyExp = document.getElementById('copy-exp')
const copyCvc = document.getElementById('copy-cvc')

if (copyCard) copyCard.textContent = TEST_VALUES.number
if (copyExp) copyExp.textContent = TEST_VALUES.exp
if (copyCvc) copyCvc.textContent = TEST_VALUES.cvc

copyCard?.addEventListener('click', () => copyText(TEST_VALUES.number))
copyExp?.addEventListener('click', () => copyText(TEST_VALUES.exp))
copyCvc?.addEventListener('click', () => copyText(TEST_VALUES.cvc))

actionButton?.addEventListener('click', async () => {
  output.textContent = ''
  log('GET /api/fortune')
  setFormError(null)
  if (fortuneEl) fortuneEl.textContent = ''
  if (actionButton) actionButton.disabled = true

  try {
    const response = await fetch('/api/fortune')
    log(`HTTP ${response.status}`)

    if (response.status !== 402) throw new Error(`Unexpected status: ${response.status}`)

    const challenge = Challenge.fromResponse(response, { methods: [charge] })
    log(`→ challenge:\n${JSON.stringify(challenge, null, 2)}`)

    const paymentMethodTypes = challenge.request.methodDetails?.paymentMethodTypes as string[]
    log(`Payment method types: ${paymentMethodTypes.join(', ')}`)

    // Create Payment Element using types from the challenge
    const elements = stripeClient.elements({
      mode: 'payment',
      amount: Number(challenge.request.amount),
      currency: challenge.request.currency as string,
      paymentMethodTypes,
      paymentMethodCreation: 'manual',
    })
    const paymentElement = elements.create('payment', {
      fields: {
        billingDetails: { address: { postalCode: 'never', country: 'never' } },
      },
    })
    if (paymentForm) {
      paymentForm.innerHTML = '<div id="payment-element"></div>'
      paymentForm.classList.remove('hidden')
    }
    paymentElement.mount('#payment-element')
    // Expose for testing
    ;(window as any).__stripeElements = elements
    if (actionButton) actionButton.classList.add('hidden')
    if (testHelpers) testHelpers.classList.remove('hidden')

    log('Collecting payment details...')
    const submitButton = document.getElementById('submit-payment') as HTMLButtonElement | null
    if (submitButton) submitButton.classList.remove('hidden')

    // Wait for user to click "Confirm Payment"
    const paymentMethod = await new Promise<{ id: string }>((resolve, reject) => {
      submitButton?.addEventListener(
        'click',
        async () => {
          try {
            const { error: submitError } = await elements.submit()
            if (submitError?.message) return reject(new Error(submitError.message))

            const { error: pmError, paymentMethod } =
              await stripeClient.createPaymentMethod({
                elements,
                params: {
                  billing_details: {
                    address: { postal_code: '10001', country: 'US' },
                  },
                },
              })
            if (pmError?.message) return reject(new Error(pmError.message))
            if (!paymentMethod?.id) return reject(new Error('Failed to create PaymentMethod'))
            if (submitButton) submitButton.classList.add('hidden')
            if (paymentForm) paymentForm.classList.add('hidden')
            if (testHelpers) testHelpers.classList.add('hidden')
            resolve(paymentMethod)
          } catch (err) {
            reject(err)
          }
        },
        { once: true },
      )
    })

    const credential = await charge.createCredential({
      challenge,
      context: {
        paymentMethod: paymentMethod.id,
      },
    })
    log('Retrying with credential...')

    const paid = await fetch('/api/fortune', {
      headers: { Authorization: credential },
    })
    log(`HTTP ${paid.status}`)

    if (!paid.ok) throw new Error(`Payment failed: ${paid.status}`)

    const receipt = Receipt.fromResponse(paid)
    log(`${receipt.method} / ${receipt.status} / ${receipt.reference}`)

    const { fortune } = await paid.json()
    if (fortuneEl) fortuneEl.textContent = fortune
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`Error: ${message}`)
    setFormError(message)
    if (actionButton) actionButton.disabled = false
  }
})
