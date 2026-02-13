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
const elements = stripeClient.elements()
const cardElement = elements.create('card', { hidePostalCode: true })
cardElement.mount('#card-element')

const output = document.getElementById('output')!
const testStatus = document.getElementById('test-status')
const formError = document.getElementById('form-error')
const cardForm = document.getElementById('card-form')
const fortuneEl = document.getElementById('fortune')
const actionButton = document.getElementById('button') as HTMLButtonElement | null

if (actionButton) actionButton.disabled = true

cardElement.on('change', (event: { complete?: boolean }) => {
  if (!actionButton) return
  actionButton.disabled = !event.complete
})

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
  if (cardForm) {
    cardForm.classList.add('hidden')
    cardForm.setAttribute('hidden', 'true')
  }

  try {
    const response = await fetch('/api/fortune')
    log(`HTTP ${response.status}`)

    if (response.status !== 402) throw new Error(`Unexpected status: ${response.status}`)

    const challenge = Challenge.fromResponse(response, { methods: [charge] })
    log(`→ challenge:\n${JSON.stringify(challenge, null, 2)}`)

    log('Collecting card details...')
    const paymentMethodResult = await stripeClient.createPaymentMethod({
      type: 'card',
      card: cardElement,
    })
    if (paymentMethodResult.error?.message) throw new Error(paymentMethodResult.error.message)
    if (!paymentMethodResult.paymentMethod?.id) throw new Error('Failed to create PaymentMethod')

    const credential = await charge.createCredential({
      challenge,
      context: {
        paymentMethod: paymentMethodResult.paymentMethod.id,
      },
    })
    log('Retrying with credential...')

    const paid = await fetch('/api/fortune', {
      headers: { Authorization: credential },
    })
    log(`HTTP ${paid.status}`)

    if (!paid.ok) throw new Error(`Payment failed: ${paid.status}`)

    const receipt = Receipt.fromResponse(paid)
    log(`✓ ${receipt.method} / ${receipt.status} / ${receipt.reference}`)

    const { fortune } = await paid.json()
    if (fortuneEl) fortuneEl.textContent = fortune
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`✗ ${message}`)
    setFormError(message)
    if (actionButton) actionButton.disabled = false
  }
})
