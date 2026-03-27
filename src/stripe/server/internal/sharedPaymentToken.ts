import * as z from '../../../zod.js'
import type { StripeClient } from '../../internal/types.js'

const createSptPath = '/v1/test_helpers/shared_payment/granted_tokens'
const createSptRequestSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  expiresAt: z.number(),
  metadata: z.optional(z.record(z.string(), z.string())),
  networkId: z.optional(z.string()),
  paymentMethod: z.string(),
})

async function createSpt(parameters: {
  client?: StripeClient | undefined
  parameters: Record<string, unknown>
  secretKey?: string | undefined
}): Promise<{ success: true; result: { id: string } } | { success: false; error: unknown } | null> {
  const { client, parameters: requestParameters, secretKey } = parameters

  if (client?.rawRequest) {
    try {
      const result = (await client.rawRequest('POST', createSptPath, requestParameters)) as {
        id: string
      }
      return { success: true, result }
    } catch (error) {
      return { success: false, error }
    }
  }

  if (!secretKey) return null

  const body = new URLSearchParams()
  appendFormFields(body, requestParameters)

  const response = await fetch(`https://api.stripe.com${createSptPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: { message?: string } }
    return { success: false, error }
  }

  return { success: true, result: (await response.json()) as { id: string } }
}

/** @internal */
export async function createTokenResponse(parameters: {
  client?: StripeClient | undefined
  request: globalThis.Request
  secretKey?: string | undefined
}): Promise<globalThis.Response> {
  const { client, request, secretKey } = parameters

  const parsed = createSptRequestSchema.safeParse(await request.json())
  if (!parsed.success)
    return Response.json(
      {
        error: parsed.error.issues[0]?.message ?? 'Invalid Stripe create token request',
      },
      { status: 400 },
    )

  const { paymentMethod, amount, currency, expiresAt, networkId, metadata } = parsed.data

  try {
    let spt = await createSpt({
      client,
      parameters: buildCreateSptParameters({
        amount,
        currency,
        expiresAt,
        metadata,
        networkId,
        paymentMethod,
      }),
      secretKey,
    })
    if (!spt) throw new Error('client.rawRequest() or secretKey is required for SPT creation')

    if ((metadata || networkId) && !spt.success) {
      const message = getStripeErrorMessage(spt.error)
      if (message && message.includes('Received unknown parameter')) {
        spt = await createSpt({
          client,
          parameters: buildCreateSptParameters({
            amount,
            currency,
            expiresAt,
            paymentMethod,
          }),
          secretKey,
        })
      }
    }

    if (!spt?.success)
      return Response.json(
        { error: getStripeErrorMessage(spt?.error) ?? 'Unknown error' },
        { status: 500 },
      )

    return Response.json({ spt: spt.result.id })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}

function buildCreateSptParameters(parameters: {
  amount: string
  currency: string
  expiresAt: number
  metadata?: Record<string, string> | undefined
  networkId?: string | undefined
  paymentMethod: string
}) {
  const { amount, currency, expiresAt, metadata, networkId, paymentMethod } = parameters

  return {
    payment_method: paymentMethod,
    usage_limits: {
      currency,
      expires_at: expiresAt,
      max_amount: amount,
    },
    ...(networkId ? { seller_details: { network_id: networkId } } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function appendFormFields(
  searchParams: URLSearchParams,
  value: Record<string, unknown> | unknown[],
  prefix?: string,
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      appendFormValue(searchParams, item, `${prefix ?? ''}[${index}]`)
    return
  }

  for (const [key, item] of Object.entries(value)) {
    appendFormValue(searchParams, item, prefix ? `${prefix}[${key}]` : key)
  }
}

function appendFormValue(searchParams: URLSearchParams, value: unknown, key: string): void {
  if (value == null) return
  if (Array.isArray(value)) {
    appendFormFields(searchParams, value, key)
    return
  }
  if (typeof value === 'object') {
    appendFormFields(searchParams, value as Record<string, unknown>, key)
    return
  }
  searchParams.set(key, String(value))
}

function getStripeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string') return message
  }
}
