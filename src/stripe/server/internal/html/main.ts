import type { Appearance } from '@stripe/stripe-js'
import { loadStripe } from '@stripe/stripe-js/pure'

import type * as Challenge from '../../../../Challenge.js'
import { stripe } from '../../../../client/index.js'
import * as Html from '../../../../server/internal/html/config.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type { charge as chargeClient } from '../../../../stripe/client/Charge.js'
import type { charge } from '../../../../stripe/server/Charge.js'
import type * as Methods from '../../../Methods.js'

const data = JSON.parse(document.getElementById(Html.dataId)!.textContent!) as {
  config: NonNullable<charge.Parameters['html']>
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
  theme: {
    [k in keyof Omit<Html.Theme, 'fontUrl' | 'logo'>]-?: NonNullable<Html.Theme[k]>
  }
}

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'stripe'
root.appendChild(h2)

;(async () => {
  if (import.meta.env.MODE === 'test') {
    const button = document.createElement('button')
    button.textContent = 'Pay'
    root.appendChild(button)
    button.onclick = async () => {
      try {
        button.disabled = true
        const method = stripe({ createToken })[0]
        const credential = await method.createCredential({
          challenge: data.challenge,
          context: { paymentMethod: 'pm_card_visa' },
        })
        await submitCredential(credential)
      } finally {
        button.disabled = false
      }
    }
    return
  }

  const stripeJs = await loadStripe(data.config.publishableKey)
  if (!stripeJs) throw new Error('Failed to loadStripe')

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const getAppearance = () => {
    const theme = (() => {
      if (data.config.elements?.options?.appearance?.theme)
        return data.config.elements?.options?.appearance?.theme
      switch (data.theme.colorScheme) {
        case 'light dark':
          return (darkQuery.matches ? 'night' : 'stripe') as 'night' | 'stripe'
        case 'light':
          return 'stripe' as const
        case 'dark':
          return 'night' as const
      }
    })()
    const resolvedColorSchemeIndex = darkQuery ? 1 : 0
    console.log({ theme, resolvedColorSchemeIndex, darkQuery })
    return Html.mergeDefined(
      {
        theme,
        variables: {
          colorPrimary: data.theme.accent[resolvedColorSchemeIndex],
          colorBackground: data.theme.surface[resolvedColorSchemeIndex],
          colorText: data.theme.foreground[resolvedColorSchemeIndex],
          colorTextSecondary: data.theme.muted[resolvedColorSchemeIndex],
          colorDanger: data.theme.negative[resolvedColorSchemeIndex],
          fontFamily: data.theme.fontFamily,
          fontWeightNormal: '400',
          fontSizeSm: '0.875rem',
          borderRadius: data.theme.radius,
          spacingUnit: '2px',
        },
      } satisfies Appearance,
      (data.config.elements?.options?.appearance as never) ?? {},
    )
  }

  const elements = stripeJs.elements({
    appearance: getAppearance(),
    ...data.config.elements?.options,
    amount: Number(data.challenge.request.amount),
    currency: data.challenge.request.currency,
    mode: 'payment',
    paymentMethodCreation: 'manual',
    paymentMethodTypes: data.challenge.request.methodDetails.paymentMethodTypes,
  })

  darkQuery.addEventListener('change', () => {
    elements.update({ appearance: getAppearance() })
  })

  const form = document.createElement('form')
  elements.create('payment', data.config.elements?.paymentOptions).mount(form)
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
      const { paymentMethod, error } = await stripeJs.createPaymentMethod({
        ...data.config.elements?.createPaymentMethodOptions,
        elements,
      })
      if (error || !paymentMethod) throw error ?? new Error('Failed to create payment method')
      const method = stripe({ client: stripeJs, createToken })[0]
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

async function createToken(opts: chargeClient.OnChallengeParameters) {
  const createTokenUrl = new URL(data.config.createTokenUrl, location.origin)
  if (createTokenUrl.origin !== location.origin)
    throw new Error('createTokenUrl must be same-origin')
  const res = await fetch(createTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<response body unavailable>')
    throw new Error(`Failed to create SPT (${res.status}): ${text}`)
  }
  const json = (await res.json()) as { spt: string }
  return json.spt
}
