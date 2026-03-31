import { loadStripe } from '@stripe/stripe-js'

import type * as Challenge from '../../../../Challenge.js'
import { stripe } from '../../../../client/index.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type { charge } from '../../../../stripe/server/Charge.js'
import type * as Methods from '../../../Methods.js'

const data = JSON.parse(document.getElementById('__MPPX_DATA__')!.textContent!) as {
  config: NonNullable<charge.Parameters['html']>
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'stripe'
root.appendChild(h2)

;(async () => {
  const stripeJs = (await loadStripe(data.config.publishableKey))!
  if (!stripeJs) throw new Error('Failed to loadStripe')

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const getAppearance = () => ({
    theme: (darkQuery.matches ? 'night' : 'stripe') as 'night' | 'stripe',
  })

  const elements = stripeJs.elements({
    amount: Number(data.challenge.request.amount),
    appearance: getAppearance(),
    currency: data.challenge.request.currency as string,
    mode: 'payment',
    paymentMethodCreation: 'manual',
  })

  darkQuery.addEventListener('change', () => {
    elements.update({ appearance: getAppearance() })
  })

  const form = document.createElement('form')
  elements.create('payment').mount(form)
  root.appendChild(form)

  const button = document.createElement('button')
  button.textContent = 'Pay'
  button.type = 'submit'
  form.appendChild(button)

  form.onsubmit = async (event) => {
    event.preventDefault()
    button.disabled = true

    try {
      await elements.submit()
      const { paymentMethod, error } = await stripeJs.createPaymentMethod({ elements })
      if (error || !paymentMethod) throw error ?? new Error('Failed to create payment method')

      const method = stripe({
        client: stripeJs,
        createToken: async (opts) => {
          const createTokenUrl = new URL(data.config.createTokenUrl, location.origin)
          if (createTokenUrl.origin !== location.origin)
            throw new Error('createTokenUrl must be same-origin')
          const res = await fetch(createTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentMethod, ...opts }),
          })
          if (!res.ok) throw new Error('Failed to create SPT')
          const { spt } = (await res.json()) as { spt: string }
          return spt
        },
      })[0]

      const credential = await method.createCredential({
        challenge: data.challenge,
        context: { paymentMethod: paymentMethod.id },
      })

      await submitCredential(credential)
    } finally {
      button.disabled = false
    }
  }
})()
