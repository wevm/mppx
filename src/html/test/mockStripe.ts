let frameId = 0

type MockElements = {
  create(
    type: string,
    _options?: unknown,
  ): {
    mount(element: HTMLElement): void
  }
  submit(): Promise<{ error?: { message: string } }>
  update(_options: unknown): void
}

function createPaymentFrame(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.name = `__privateStripeFrame_mock_${++frameId}`
  iframe.title = 'Secure payment input frame'
  iframe.style.width = '100%'
  iframe.style.height = '180px'
  iframe.style.border = '0'
  iframe.srcdoc = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <style>
        body {
          font-family: sans-serif;
          margin: 0;
          padding: 12px;
          display: grid;
          gap: 10px;
          background: white;
        }
        input {
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-sizing: border-box;
          font-size: 16px;
          padding: 10px 12px;
          width: 100%;
        }
      </style>
    </head>
    <body>
      <input name="number" placeholder="4242 4242 4242 4242" />
      <input name="expiry" placeholder="MM / YY" />
      <input name="cvc" placeholder="CVC" />
      <input name="postalCode" placeholder="ZIP" />
    </body>
  </html>`
  return iframe
}

export async function loadStripe(_publishableKey: string) {
  let iframe: HTMLIFrameElement | undefined

  const elements: MockElements = {
    create(type: string) {
      if (type !== 'payment') throw new Error(`Unsupported mock Stripe element: ${type}`)
      return {
        mount(element) {
          iframe = createPaymentFrame()
          element.appendChild(iframe)
        },
      }
    },
    async submit() {
      return {}
    },
    update() {},
  }

  return {
    elements() {
      return elements
    },
    async createPaymentMethod() {
      const document = iframe?.contentWindow?.document
      const number = document?.querySelector<HTMLInputElement>('[name="number"]')?.value?.trim()
      const expiry = document?.querySelector<HTMLInputElement>('[name="expiry"]')?.value?.trim()
      const cvc = document?.querySelector<HTMLInputElement>('[name="cvc"]')?.value?.trim()
      if (!number || !expiry || !cvc) {
        return { error: { message: 'Missing card details.' } }
      }
      return {
        paymentMethod: {
          id: `pm_mock_${Math.random().toString(36).slice(2, 10)}`,
        },
      }
    },
  }
}
