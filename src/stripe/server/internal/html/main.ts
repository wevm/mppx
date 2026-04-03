import type { Appearance } from '@stripe/stripe-js'
import { loadStripe } from '@stripe/stripe-js/pure'

import { stripe } from '../../../../client/index.js'
import * as Html from '../../../../Html.js'
import { mergeDefined } from '../../../../server/internal/html/config.js'
import type { charge as chargeClient } from '../../../../stripe/client/Charge.js'
import type { charge } from '../../../../stripe/server/Charge.js'
import type * as Methods from '../../../Methods.js'

const c = Html.init<typeof Methods.charge, NonNullable<charge.Parameters['html']>>('stripe')

const css = String.raw
const style = document.createElement('style')
style.textContent = css`
  form {
    display: flex;
    flex-direction: column;
    gap: calc(${c.vars.spacingUnit} * 8);
  }
  button {
    background: ${c.vars.accent};
    border-radius: ${c.vars.radius};
    color: ${c.vars.background};
    cursor: pointer;
    font-weight: 500;
    padding: calc(${c.vars.spacingUnit} * 4) calc(${c.vars.spacingUnit} * 8);
    width: 100%;
  }
  button:hover:not(:disabled) {
    opacity: 0.85;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
`
c.root.append(style)

;(async () => {
  if (import.meta.env.MODE === 'test') {
    const button = document.createElement('button')
    button.textContent = c.text.pay
    c.root.appendChild(button)
    button.onclick = async () => {
      try {
        button.disabled = true
        const method = stripe({ createToken })[0]
        const credential = await method.createCredential({
          challenge: c.challenge,
          context: { paymentMethod: 'pm_card_visa' },
        })
        await c.submit(credential)
      } catch (error) {
        c.error(error instanceof Error ? error.message : 'Payment failed')
      } finally {
        button.disabled = false
      }
    }
    return
  }

  const stripeJs = await loadStripe(c.config.publishableKey)
  if (!stripeJs) throw new Error('Failed to loadStripe')

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const getAppearance = () => {
    const theme = (() => {
      if (c.config.elements?.options?.appearance?.theme)
        return c.config.elements?.options?.appearance?.theme
      switch (c.theme.colorScheme) {
        case 'light dark':
          return (darkQuery.matches ? 'night' : 'stripe') as 'night' | 'stripe'
        case 'light':
          return 'stripe' as const
        case 'dark':
          return 'night' as const
      }
    })()
    const resolvedColorSchemeIndex = darkQuery.matches ? 1 : 0
    return mergeDefined(
      {
        disableAnimations: true,
        theme,
        variables: {
          borderRadius: c.theme.radius,
          colorBackground: c.theme.surface[resolvedColorSchemeIndex],
          colorDanger: c.theme.negative[resolvedColorSchemeIndex],
          colorPrimary: c.theme.accent[resolvedColorSchemeIndex],
          colorText: c.theme.foreground[resolvedColorSchemeIndex],
          colorTextSecondary: c.theme.muted[resolvedColorSchemeIndex],
          fontSizeBase: c.theme.fontSizeBase,
          fontFamily: c.theme.fontFamily,
          spacingUnit: c.theme.spacingUnit,
        },
      } satisfies Appearance,
      (c.config.elements?.options?.appearance as never) ?? {},
    )
  }

  const elements = stripeJs.elements({
    appearance: getAppearance(),
    ...c.config.elements?.options,
    amount: Number(c.challenge.request.amount),
    currency: c.challenge.request.currency,
    mode: 'payment',
    paymentMethodCreation: 'manual',
    paymentMethodTypes: c.challenge.request.methodDetails.paymentMethodTypes,
  })

  darkQuery.addEventListener('change', () => {
    elements.update({ appearance: getAppearance() })
  })

  const form = document.createElement('form')
  elements.create('payment', c.config.elements?.paymentOptions).mount(form)
  c.root.appendChild(form)

  const button = document.createElement('button')
  button.textContent = c.text.pay
  button.type = 'submit'
  form.appendChild(button)

  form.onsubmit = async (event) => {
    event.preventDefault()
    c.error()
    button.disabled = true
    try {
      await elements.submit()
      const { paymentMethod, error: stripeError } = await stripeJs.createPaymentMethod({
        ...c.config.elements?.createPaymentMethodOptions,
        elements,
      })
      if (stripeError || !paymentMethod)
        throw stripeError ?? new Error('Failed to create payment method')
      const method = stripe({ client: stripeJs, createToken })[0]
      const credential = await method.createCredential({
        challenge: c.challenge,
        context: { paymentMethod: paymentMethod.id },
      })
      await c.submit(credential)
    } catch (error) {
      c.error(error instanceof Error ? error.message : 'Payment failed')
    } finally {
      button.disabled = false
    }
  }
})()

async function createToken(opts: chargeClient.OnChallengeParameters) {
  const createTokenUrl = new URL(c.config.createTokenUrl, location.origin)
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
