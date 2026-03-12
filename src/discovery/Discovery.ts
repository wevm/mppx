import * as z from '../zod.js'

/**
 * Schema for the `x-payment-info` OpenAPI extension on an operation.
 *
 * Describes payment parameters for a single endpoint — intent, method,
 * amount, and optional currency/description.
 *
 * The runtime 402 challenge remains authoritative for all payment
 * parameters; this extension is for static discovery only.
 */
export const PaymentInfo = z.object({
  intent: z.union([z.literal('charge'), z.literal('session')]),
  method: z.string(),
  amount: z.union([z.null(), z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Invalid amount'))]),
  currency: z.optional(z.string()),
  description: z.optional(z.string()),
})
export type PaymentInfo = z.infer<typeof PaymentInfo>

/**
 * Schema for the `x-service-info` OpenAPI extension at the document root.
 *
 * Provides service categories and documentation links.
 */
export const ServiceInfo = z.object({
  categories: z.optional(z.array(z.string())),
  docs: z.optional(
    z.object({
      apiReference: z.optional(z.string()),
      homepage: z.optional(z.string()),
      llms: z.optional(z.string()),
    }),
  ),
})
export type ServiceInfo = z.infer<typeof ServiceInfo>

/**
 * Minimal schema for an OpenAPI 3.x discovery document annotated with
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
          responses: z.optional(z.record(z.string(), z.unknown())),
          requestBody: z.optional(z.unknown()),
          summary: z.optional(z.string()),
        }),
      ),
    ),
  ),
})
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>
