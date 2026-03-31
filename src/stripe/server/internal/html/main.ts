import { loadStripe } from '@stripe/stripe-js'

import type * as Challenge from '../../../../Challenge.js'
import { stripe } from '../../../../client/index.js'
import type * as Methods from '../../../Methods.js'

const data = JSON.parse(document.getElementById('__MPPX_DATA__')!.textContent!) as {
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'stripe'
root.appendChild(h2)

;(async () => {
  const stripeJs = (await loadStripe(
    'pk_test_51SzNfEGlV7dYX3N7FwZQBlWCF5wIqakWKw8lk1e4Saf0b2H4exVG5bBCAopgPQvo9QhU5TNsBuuIFbXSrvbBjut50090YN7Xip',
  ))!
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
          const res = await fetch('/api/create-spt', {
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

      const res = await fetch(location.pathname, {
        headers: { Authorization: credential },
      })
      console.log(await res.json())
    } finally {
      button.disabled = false
    }
  }
})()
