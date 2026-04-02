import type { Appearance } from '@stripe/stripe-js'
import { loadStripe } from '@stripe/stripe-js/pure'
import { Json } from 'ox'

import { stripe } from '../../../../client/index.js'
import * as Html from '../../../../server/internal/html/config.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type { charge as chargeClient } from '../../../../stripe/client/Charge.js'
import type { charge } from '../../../../stripe/server/Charge.js'
import type * as Methods from '../../../Methods.js'

const dataElement = document.getElementById(Html.dataId)!
const data = Json.parse(dataElement.textContent) as Html.Data<
  typeof Methods.charge,
  NonNullable<charge.Parameters['html']>
>

const root = document.getElementById(Html.rootId)!

const css = String.raw
const style = document.createElement('style')
style.textContent = css`
  form {
    display: flex;
    flex-direction: column;
    gap: calc(${Html.vars.spacingUnit} * 8);
  }
  button {
    background: ${Html.vars.accent};
    border-radius: ${Html.vars.radius};
    color: ${Html.vars.background};
    cursor: pointer;
    font-weight: 500;
    padding: calc(${Html.vars.spacingUnit} * 4) calc(${Html.vars.spacingUnit} * 8);
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
root.append(style)

;(async () => {
  if (import.meta.env.MODE === 'test') {
    const button = document.createElement('button')
    button.textContent = data.text.pay
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
      } catch (e) {
        Html.showError(e instanceof Error ? e.message : 'Payment failed')
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
    const resolvedColorSchemeIndex = darkQuery.matches ? 1 : 0
    return Html.mergeDefined(
      {
        disableAnimations: true,
        theme,
        variables: {
          borderRadius: data.theme.radius,
          colorBackground: data.theme.surface[resolvedColorSchemeIndex],
          colorDanger: data.theme.negative[resolvedColorSchemeIndex],
          colorPrimary: data.theme.accent[resolvedColorSchemeIndex],
          colorText: data.theme.foreground[resolvedColorSchemeIndex],
          colorTextSecondary: data.theme.muted[resolvedColorSchemeIndex],
          fontSizeBase: data.theme.fontSizeBase,
          fontFamily: data.theme.fontFamily,
          spacingUnit: data.theme.spacingUnit,
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
  button.textContent = data.text.pay
  button.type = 'submit'
  form.appendChild(button)

  form.onsubmit = async (event) => {
    event.preventDefault()
    document.getElementById(Html.errorId)?.remove()
    button.disabled = true
    try {
      await elements.submit()
      const { paymentMethod, error: stripeError } = await stripeJs.createPaymentMethod({
        ...data.config.elements?.createPaymentMethodOptions,
        elements,
      })
      if (stripeError || !paymentMethod)
        throw stripeError ?? new Error('Failed to create payment method')
      const method = stripe({ client: stripeJs, createToken })[0]
      const credential = await method.createCredential({
        challenge: data.challenge,
        context: { paymentMethod: paymentMethod.id },
      })
      await submitCredential(credential)
    } catch (e) {
      Html.showError(e instanceof Error ? e.message : 'Payment failed')
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

dataElement.remove()
