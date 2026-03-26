import * as z from '../zod.js'

const uriOrPathPattern = /^([a-zA-Z][a-zA-Z\d+.-]*:\/\/\S+|\/\S*)$/

function uriOrPath() {
  return z.string().check(z.regex(uriOrPathPattern, 'Invalid URI or path'))
}

/**
 * Schema for the `x-payment-info` OpenAPI extension on an operation.
 *
 * Only validates spec-defined fields when present; unknown fields are ignored.
 * Discovery is advisory only. Runtime 402 challenges remain authoritative.
 */
export const PaymentInfo = z.looseObject({
  amount: z.optional(
    z.union([z.null(), z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, 'Invalid amount'))]),
  ),
  currency: z.optional(z.string()),
  description: z.optional(z.string()),
  intent: z.optional(z.string()),
  method: z.optional(z.string()),
})
export type PaymentInfo = z.infer<typeof PaymentInfo>

const ServiceDocs = z.looseObject({
  apiReference: z.optional(uriOrPath()),
  homepage: z.optional(uriOrPath()),
  llms: z.optional(uriOrPath()),
})

/**
 * Schema for the `x-service-info` OpenAPI extension at the document root.
 */
export const ServiceInfo = z.looseObject({
  categories: z.optional(z.array(z.string())),
  docs: z.optional(ServiceDocs),
})
export type ServiceInfo = z.infer<typeof ServiceInfo>

const OperationObject = z.looseObject({
  'x-payment-info': z.optional(PaymentInfo),
  requestBody: z.optional(z.unknown()),
  responses: z.optional(z.record(z.string(), z.unknown())),
  summary: z.optional(z.string()),
})

const PathItem = z.looseObject({
  delete: z.optional(OperationObject),
  get: z.optional(OperationObject),
  head: z.optional(OperationObject),
  options: z.optional(OperationObject),
  patch: z.optional(OperationObject),
  post: z.optional(OperationObject),
  put: z.optional(OperationObject),
  trace: z.optional(OperationObject),
})

/**
 * Minimal schema for an OpenAPI discovery document annotated with
 * `x-service-info` and per-operation `x-payment-info`.
 */
export const DiscoveryDocument = z.looseObject({
  openapi: z.string(),
  info: z.looseObject({
    title: z.string(),
    version: z.string(),
  }),
  'x-service-info': z.optional(ServiceInfo),
  paths: z.optional(z.record(z.string(), PathItem)),
})
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>
