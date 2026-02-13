import { Challenge, Receipt } from 'mpay'
import { stripe } from 'mpay/client'

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
  paymentMethod: 'pm_card_visa',
})

const output = document.getElementById('output')!

function log(message: string) {
  output.textContent += `${output.textContent ? '\n' : ''}${message}`
}

document.getElementById('button')!.addEventListener('click', async () => {
  output.textContent = ''
  log('GET /api/fortune')

  try {
    const response = await fetch('/api/fortune')
    log(`HTTP ${response.status}`)

    if (response.status !== 402) throw new Error(`Unexpected status: ${response.status}`)

    const challenge = Challenge.fromResponse(response)
    log(`→ method: ${challenge.method}, intent: ${challenge.intent}`)
    log(`→ amount: ${challenge.request.amount}, currency: ${challenge.request.currency}`)

    const credential = await charge.createCredential({ challenge })
    log('Retrying with credential...')

    const paid = await fetch('/api/fortune', {
      headers: { Authorization: credential },
    })
    log(`HTTP ${paid.status}`)

    if (!paid.ok) throw new Error(`Payment failed: ${paid.status}`)

    const receipt = Receipt.fromResponse(paid)
    log(`✓ ${receipt.method} / ${receipt.status} / ${receipt.reference}`)

    const { fortune } = await paid.json()
    document.getElementById('fortune')!.textContent = fortune
  } catch (err) {
    log(`✗ ${err}`)
  }
})
