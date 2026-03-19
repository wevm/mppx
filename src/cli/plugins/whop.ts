import { Errors } from 'incur'
import { whop as whopMethods } from '../../whop/client/index.js'
import { pc } from '../utils.js'
import { createPlugin } from './plugin.js'

export function whop() {
  return createPlugin({
    method: 'whop',

    async setup({ challenge }) {
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as string | undefined
      const purchaseUrl = challenge.opaque?.purchase_url as string | undefined

      return {
        tokenSymbol: currency?.toUpperCase() ?? 'USD',
        tokenDecimals: 2,
        methods: [
          whopMethods.charge({
            completeCheckout: async ({ purchaseUrl: url }) => {
              const checkoutUrl = url || purchaseUrl
              if (!checkoutUrl) {
                throw new Errors.IncurError({
                  code: 'MISSING_CHECKOUT_URL',
                  message:
                    'No Whop checkout URL available. The server must include a purchase_url in the challenge.',
                  exitCode: 2,
                })
              }

              // Open the checkout URL in the default browser
              console.log(`\n${pc.bold('Whop Checkout')}`)
              console.log(`Opening checkout in your browser...\n`)
              console.log(`  ${pc.link(checkoutUrl, checkoutUrl, true)}\n`)

              // Open URL in the default browser using platform-native commands
              try {
                const { exec } = await import('node:child_process')
                const cmd =
                  process.platform === 'darwin'
                    ? `open "${checkoutUrl}"`
                    : process.platform === 'win32'
                      ? `start "${checkoutUrl}"`
                      : `xdg-open "${checkoutUrl}"`
                exec(cmd)
              } catch {
                console.log(`Open this URL manually to complete payment.`)
              }

              // Prompt the user to paste the payment ID after checkout
              console.log(
                `After completing payment, paste the payment ID from the redirect URL.`,
              )
              console.log(
                `(The payment ID looks like: ${pc.dim('pay_xxxxxxxxxxxxx')})\n`,
              )

              const paymentId = await promptForPaymentId()
              if (!paymentId) {
                throw new Errors.IncurError({
                  code: 'PAYMENT_CANCELLED',
                  message: 'Payment was cancelled or no payment ID was provided.',
                  exitCode: 1,
                })
              }

              return paymentId
            },
          }),
        ],
      }
    },

    formatReceiptField(key, value) {
      if (key === 'reference' && typeof value === 'string') {
        const url = `https://whop.com/dashboard/payments`
        return pc.link(url, value, true)
      }
    },
  })
}

/** Prompts the user to enter the payment ID from the CLI. */
async function promptForPaymentId(): Promise<string | null> {
  const readline = await import('node:readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Payment ID: ', (answer) => {
      rl.close()
      const trimmed = answer.trim()
      resolve(trimmed || null)
    })
  })
}
