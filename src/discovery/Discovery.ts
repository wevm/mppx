import * as z from '../zod.js'

const uriPattern = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/\S+$/

function uri() {
  return z.string().check(z.regex(uriPattern, 'Invalid URI'))
}

/**
 * Schema for the `x-payment-info` OpenAPI extension on an operation.
 *
 * Discovery is advisory only. Runtime 402 challenges remain authoritative.
 */
export const PaymentInfo = z.object({
  amount: z.union([z.null(), z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Invalid amount'))]),
  currency: z.optional(z.string()),
  description: z.optional(z.string()),
  intent: z.string(),
  method: z.string(),
})
export type PaymentInfo = z.infer<typeof PaymentInfo>

const ServiceDocs = z.object({
  apiReference: z.optional(uri()),
  homepage: z.optional(uri()),
  llms: z.optional(uri()),
})

/**
 * Schema for the `x-service-info` OpenAPI extension at the document root.
 */
export const ServiceInfo = z.object({
  categories: z.optional(z.array(z.string())),
  docs: z.optional(ServiceDocs),
})
export type ServiceInfo = z.infer<typeof ServiceInfo>

/**
 * Minimal schema for an OpenAPI discovery document annotated with
 * `x-service-info` and per-operation `x-payment-info`.
 */
export const DiscoveryDocument = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }),
  'x-service-info': z.optional(ServiceInfo),
  paths: z.optional(
    z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({
          'x-payment-info': z.optional(PaymentInfo),
          requestBody: z.optional(z.unknown()),
          responses: z.optional(z.record(z.string(), z.unknown())),
          summary: z.optional(z.string()),
        }),
      ),
    ),
  ),
})
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>
