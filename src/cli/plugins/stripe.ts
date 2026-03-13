import { Errors, z } from 'incur'
import { stripe as stripeMethods } from '../../stripe/client/index.js'
import { pc } from '../utils.js'
import { createPlugin } from './plugin.js'

export function stripe() {
  return createPlugin({
    method: 'stripe',

    async setup({ challenge, methodOpts }) {
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as string | undefined

      const stripeOpts = parseOptions(
        z.object({
          paymentMethod: z.string(),
        }),
        methodOpts,
      )

      const stripeSecretKey = process.env.MPPX_STRIPE_SECRET_KEY
      if (!stripeSecretKey)
        throw new Errors.IncurError({
          code: 'MISSING_ENV',
          message: 'MPPX_STRIPE_SECRET_KEY environment variable is required for Stripe payments.',
          exitCode: 2,
        })
      if (!stripeSecretKey.startsWith('sk_test_'))
        throw new Errors.IncurError({
          code: 'UNSUPPORTED_MODE',
          message:
            'Stripe CLI payments are currently only supported in test mode (sk_test_... keys).',
          exitCode: 2,
        })

      return {
        tokenSymbol: currency?.toUpperCase() ?? '',
        tokenDecimals: (challengeRequest.decimals as number | undefined) ?? 2,
        methods: [
          stripeMethods.charge({
            paymentMethod: stripeOpts.paymentMethod,
            createToken: async ({
              paymentMethod,
              amount,
              currency,
              networkId,
              expiresAt,
              metadata,
            }) => {
              const body = new URLSearchParams({
                payment_method: paymentMethod!,
                'usage_limits[currency]': currency,
                'usage_limits[max_amount]': amount,
                'usage_limits[expires_at]': expiresAt.toString(),
              })
              if (networkId) body.set('seller_details[network_id]', networkId)
              if (metadata) {
                for (const [key, value] of Object.entries(metadata)) {
                  body.set(`metadata[${key}]`, value)
                }
              }

              const sptUrl =
                process.env.MPPX_STRIPE_SPT_URL ??
                'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens'
              const sptHeaders = {
                Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              }

              let response = await globalThis.fetch(sptUrl, {
                method: 'POST',
                headers: sptHeaders,
                body,
              })
              if (!response.ok) {
                const errorBody = (await response.json()) as { error: { message: string } }
                if (
                  (metadata || networkId) &&
                  errorBody.error.message.includes('Received unknown parameter')
                ) {
                  const fallbackBody = new URLSearchParams({
                    payment_method: paymentMethod!,
                    'usage_limits[currency]': currency,
                    'usage_limits[max_amount]': amount,
                    'usage_limits[expires_at]': expiresAt.toString(),
                  })
                  response = await globalThis.fetch(sptUrl, {
                    method: 'POST',
                    headers: sptHeaders,
                    body: fallbackBody,
                  })
                  if (!response.ok) {
                    const fallbackError = (await response.json()) as {
                      error: { message: string }
                    }
                    throw new Errors.IncurError({
                      code: 'STRIPE_ERROR',
                      message: `Failed to create SPT: ${fallbackError.error.message}`,
                      exitCode: 77,
                    })
                  }
                } else
                  throw new Errors.IncurError({
                    code: 'STRIPE_ERROR',
                    message: `Failed to create SPT: ${errorBody.error.message}`,
                    exitCode: 77,
                  })
              }
              const { id } = (await response.json()) as { id: string }
              return id
            },
          }),
        ],
      }
    },

    formatReceiptField(key, value) {
      if (key === 'reference' && typeof value === 'string' && value.startsWith('pi_')) {
        const isTest = process.env.MPPX_STRIPE_SECRET_KEY?.startsWith('sk_test_')
        const url = `https://dashboard.stripe.com${isTest ? '/test' : ''}/payments/${value}`
        return pc.link(url, value, true)
      }
    },
  })
}

// --- Helpers ---

function parseOptions<const schema extends z.ZodType>(
  schema: schema,
  rawOptions: unknown,
): z.output<schema> {
  const result = schema.safeParse(rawOptions ?? {})
  if (result.success) return result.data
  const summary = result.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'options'
      return `${path}: ${issue.message}`
    })
    .join(', ')
  throw new Error(`Invalid CLI options (${summary})`)
}
