import { mount } from '../../../../mount.js'

mount((c) => {
  c.setAmount('$10.00')

  const form = c.root.querySelector<HTMLFormElement>('#payment-form')!
  form.onsubmit = (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const code = data.get('code') as string
    if (!code) return
    c.dispatch({ code, type: 'code' })
  }
})
