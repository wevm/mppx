import { mount } from '../../../../index.js'

mount((c) => {
  c.set('amount', '$10.00')

  const form = c.root.querySelector<HTMLFormElement>('#payment-form')!
  form.onsubmit = (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const code = data.get('code') as string
    const serverToken = data.get('serverToken') as string
    if (!code || !serverToken) return
    c.dispatch({ code, serverToken, type: 'code' })
  }
})
