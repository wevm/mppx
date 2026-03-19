import { Mppx, whop } from 'mppx/client'

let resolvePaymentId: ((id: string) => void) | null = null

const mppx = Mppx.create({
  methods: [
    whop({
      completeCheckout: async ({ purchaseUrl }) => {
        const form = document.getElementById('payment-form')!
        const statusEl = document.getElementById('checkout-status')!
        const linkEl = document.getElementById('checkout-link')!
        const manualInput = document.getElementById('manual-input')!

        // Show the waiting UI
        form.classList.add('visible')
        statusEl.innerHTML = '<span class="spinner"></span> Waiting for payment...'
        linkEl.innerHTML = `<a href="${purchaseUrl}" target="_blank">Open checkout again &rarr;</a>`
        manualInput.style.display = 'none'

        // Open checkout in a new tab
        window.open(purchaseUrl, '_blank')

        // Extract session ID for polling
        const sessionId = new URL(purchaseUrl).searchParams.get('session') ?? ''

        return new Promise<string>((resolve, reject) => {
          resolvePaymentId = resolve
          let attempts = 0

          const poll = setInterval(async () => {
            attempts++

            // Show manual fallback after 20 seconds
            if (attempts === 10) {
              manualInput.style.display = 'block'
            }

            // Give up polling after 5 minutes
            if (attempts > 150) {
              clearInterval(poll)
              statusEl.innerHTML = 'Polling timed out. Enter payment ID manually:'
              return
            }

            try {
              const res = await fetch(`/api/check-payment?session=${encodeURIComponent(sessionId)}`)
              const data = (await res.json()) as { status: string; paymentId?: string }

              if (data.status === 'paid' && data.paymentId) {
                clearInterval(poll)
                statusEl.innerHTML = `Payment confirmed: <code>${data.paymentId}</code>`
                form.classList.remove('visible')
                resolvePaymentId = null
                resolve(data.paymentId)
              }
            } catch {
              // will retry
            }
          }, 2000)
        })
      },
    }),
  ],
})

// Manual fallback
function submitPaymentId() {
  const input = document.getElementById('payment-id-input') as HTMLInputElement
  const id = input.value.trim()
  if (!id) return
  document.getElementById('payment-form')!.classList.remove('visible')
  if (resolvePaymentId) {
    resolvePaymentId(id)
    resolvePaymentId = null
  }
}
document.getElementById('submit-payment')!.addEventListener('click', submitPaymentId)
document.getElementById('payment-id-input')!.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPaymentId()
})

// Main button
document.getElementById('button')!.addEventListener('click', async () => {
  const output = document.getElementById('output')!
  const button = document.getElementById('button') as HTMLButtonElement
  button.disabled = true
  output.innerHTML = '<div class="placeholder">Requesting payment...</div>'
  try {
    const res = await mppx.fetch('/api/fortune')
    if (!res.ok) throw new Error(`Request failed: ${res.status}`)
    const { fortune } = (await res.json()) as { fortune: string }
    output.innerHTML = `<div class="fortune">${fortune}</div>`
  } catch (err) {
    output.innerHTML = `<span class="error">${String(err)}</span>`
  } finally {
    button.disabled = false
  }
})

const setup = document.getElementById('setup')
const ready = document.getElementById('ready')
if (setup) setup.style.display = 'none'
if (ready) ready.style.display = 'block'
