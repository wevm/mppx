import { loadStripe } from '@stripe/stripe-js/pure'

import { methodElementId } from '../../../server/Html.js'

const root = document.getElementById(methodElementId)
if (!root) throw new Error('Missing root element')

const form = document.createElement('div')
form.style.maxWidth = '400px'

const paymentElement = document.createElement('div')
paymentElement.style.marginBottom = '12px'
form.appendChild(paymentElement)

const payButton = document.createElement('button')
payButton.type = 'button'
payButton.textContent = 'Pay with card'
form.appendChild(payButton)

const statusElement = document.createElement('output')
form.appendChild(statusElement)

root.appendChild(form)

const stripe = await loadStripe(mppx.config.publishableKey)
if (!stripe) throw new Error('Failed to load stripe')

const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const elements = stripe.elements({
  mode: 'payment',
  amount: Number(mppx.challenge.request.amount),
  appearance: { theme: isDark ? 'night' : 'stripe', variables: { spacingUnit: '3px' } },
  currency: mppx.challenge.request.currency,
  paymentMethodCreation: 'manual',
  paymentMethodTypes: ['card'],
})
elements
  .create('payment', {
    fields: {
      billingDetails: {
        address: { country: 'never' },
      },
    },
    layout: 'tabs',
    wallets: { link: 'never' },
  })
  .mount(paymentElement)

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  elements.update({ appearance: { theme: event.matches ? 'night' : 'stripe' } })
})

payButton.onclick = async () => {
  payButton.disabled = true

  const submitResult = await elements.submit()
  if (submitResult.error) {
    statusElement.textContent = submitResult.error.message || 'Failed to submit elements.'
    statusElement.style.color = 'red'
    payButton.disabled = false
    return
  }

  const result = await stripe.createPaymentMethod({
    elements,
    params: {
      billing_details: {
        address: { country: new Intl.Locale(navigator.language).region ?? 'US' },
      },
    },
  })
  if (result.error) {
    statusElement.textContent = result.error.message || 'Failed to create payment method.'
    statusElement.style.color = 'red'
    payButton.disabled = false
    return
  }

  const response = await fetch(mppx.config.createTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentMethod: result.paymentMethod.id,
      amount: String(mppx.challenge.request.amount),
      currency: mppx.challenge.request.currency,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  })
  if (!response.ok) {
    const json = (await response.json()) as { error?: string }
    statusElement.textContent = json.error || 'Failed to create token.'
    statusElement.style.color = 'red'
    payButton.disabled = false
    return
  }

  const { spt } = (await response.json()) as { spt: string }
  mppx.dispatch({ spt })
}
