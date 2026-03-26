import { loadStripe } from '@stripe/stripe-js/pure'

import type { Methods } from '../../../stripe/index.js'
import type { charge } from '../../../stripe/server/Charge.js'
import { mount } from '../../index.js'

mount<typeof Methods.charge, charge.HtmlConfig>(async (c) => {
  const request = c.challenge.request

  // DOM
  const form = document.createElement('div')

  const paymentElement = document.createElement('div')
  paymentElement.style.marginBottom = '12px'
  form.appendChild(paymentElement)

  const payButton = document.createElement('button')
  payButton.className = c.classNames.button
  payButton.type = 'button'
  payButton.textContent = 'Pay'
  form.appendChild(payButton)

  const statusElement = document.createElement('output')
  statusElement.id = 'status'
  statusElement.className = c.classNames.status
  form.appendChild(statusElement)

  c.root.appendChild(form)

  // Register formatted amount
  try {
    const formatted = new Intl.NumberFormat(navigator.language, {
      style: 'currency',
      currency: request.currency.toUpperCase(),
    }).format(Number(request.amount) / 100)
    c.setAmount(formatted)
  } catch {}

  // Stripe
  const stripe = await loadStripe(c.config.publishableKey)
  if (!stripe) throw new Error('Failed to load stripe')

  function getAppearance(): import('@stripe/stripe-js').Appearance {
    const style = getComputedStyle(document.documentElement)
    const get = (name: string) => style.getPropertyValue(name).trim()
    return {
      theme: 'flat',
      labels: 'floating' as const,
      variables: {
        colorPrimary: get('--mppx-accent'),
        colorBackground: get('--mppx-surface'),
        colorText: get('--mppx-foreground'),
        colorTextSecondary: get('--mppx-muted'),
        colorDanger: get('--mppx-negative'),
        fontFamily: get('--mppx-font-family'),
        fontWeightNormal: '400',
        fontSizeSm: '0.875rem',
        borderRadius: get('--mppx-radius'),
        spacingUnit: '2px',
      },
      rules: {
        '.Input': {
          padding: '10px 14px',
        },
      },
    }
  }

  const elements = stripe.elements({
    mode: 'payment',
    amount: Number(request.amount),
    appearance: getAppearance(),
    currency: request.currency,
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

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    elements.update({ appearance: getAppearance() })
  })

  // Update Stripe Elements when theme CSS variables change (e.g. theme switcher)
  new MutationObserver(() => {
    requestAnimationFrame(() => elements.update({ appearance: getAppearance() }))
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })

  payButton.onclick = async () => {
    payButton.disabled = true

    const submitResult = await elements.submit()
    if (submitResult.error) {
      statusElement.textContent = submitResult.error.message || 'Failed to submit elements.'
      statusElement.className = c.classNames.statusError
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
      statusElement.className = c.classNames.statusError
      payButton.disabled = false
      return
    }

    const response = await fetch(c.config.createTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethod: result.paymentMethod.id,
        amount: String(request.amount),
        currency: request.currency,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    })
    if (!response.ok) {
      const json = (await response.json()) as { error?: string }
      statusElement.textContent = json.error || 'Failed to create token.'
      statusElement.className = c.classNames.statusError
      payButton.disabled = false
      return
    }

    const { spt } = (await response.json()) as { spt: string }
    c.dispatch({ spt })
  }
})
