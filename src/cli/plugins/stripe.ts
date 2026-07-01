import { Errors, z } from 'incur'

import { stripe as stripeMethods } from '../../stripe/client/index.js'
import { pc } from '../utils.js'
import { createPlugin } from './plugin.js'

export function stripe() {
  return createPlugin({
    method: 'stripe',
    supports(challenge) {
      return challenge.method === 'stripe' && challenge.intent === 'charge'
    },

    async setup({ challenge, methodOpts }) {
      const challengeRequest = challenge.request as Record<string, unknown>
      const currency = challengeRequest.currency as string | undefined

      const stripeOpts = parseOptions(
        z.object({
          paymentMethod: z.string(),
        }),
        methodOpts,
        ['paymentMethod'],
      )

      const stripeSecretKey = process.env.MPPX_STRIPE_SECRET_KEY
      if (!stripeSecretKey)
        throw new Errors.IncurError({
          code: 'MISSING_ENV',
          message: 'MPPX_STRIPE_SECRET_KEY environment variable is required for Stripe payments.',
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
              const sptUrl = (() => {
                // Allow tests and custom deployments to target a specific SPT endpoint.
                if (process.env.MPPX_STRIPE_SPT_URL) return process.env.MPPX_STRIPE_SPT_URL
                // Preserve test-key behavior against Stripe's test-helper SPT endpoint.
                if (stripeSecretKey.startsWith('sk_test_'))
                  return 'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens'
                // Live keys mint Shared Payment Tokens through the agent-side issued tokens API.
                return 'https://api.stripe.com/v1/shared_payment/issued_tokens'
              })()
              if (networkId) {
                const sellerDetailsField = sptUrl.endsWith('/shared_payment/issued_tokens')
                  ? 'seller_details[network_business_profile]'
                  : 'seller_details[network_id]'
                body.set(sellerDetailsField, networkId)
              }
              if (metadata) {
                for (const [key, value] of Object.entries(metadata)) {
                  body.set(`metadata[${key}]`, value)
                }
              }

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
  allowedKeys: readonly string[],
): z.output<schema> {
  if (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
    const unknownKeys = Object.keys(rawOptions).filter((key) => !allowedKeys.includes(key))
    if (unknownKeys.length)
      throw new Error(`Unsupported CLI method option(s): ${unknownKeys.join(', ')}`)
  }
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
