import { Base64 } from 'ox'

import * as HeaderCodec from '../internal/HeaderCodec.js'
import {
  ExtensionsSchema,
  PaymentPayloadSchema,
  PaymentRequiredSchema,
  ResourceInfoSchema,
  SettleResponseSchema,
  type Extensions,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SettleResponse,
  type Version,
} from './Types.js'

const paymentRequired = HeaderCodec.createJson(PaymentRequiredSchema)
const paymentSignature = HeaderCodec.createJson(PaymentPayloadSchema)
const paymentResponse = HeaderCodec.createJson(SettleResponseSchema)

/** Encodes an x402 payment-required object for the `PAYMENT-REQUIRED` header. */
export const encodePaymentRequired: (paymentRequired: PaymentRequired) => string =
  paymentRequired.encode

/** Decodes an x402 `PAYMENT-REQUIRED` header value. */
export const decodePaymentRequired: (value: string) => PaymentRequired = paymentRequired.decode

/** Tolerant x402 `PAYMENT-REQUIRED` envelope used before filtering supported accepts. @internal */
export type PaymentRequiredEnvelope = {
  accepts: unknown[]
  extensions?: Extensions | undefined
  resource: ResourceInfo
  x402Version: Version
}

/** Decodes only the x402 `PAYMENT-REQUIRED` envelope, leaving accepts unvalidated. @internal */
export function decodePaymentRequiredEnvelope(value: string): PaymentRequiredEnvelope {
  try {
    const parsed = JSON.parse(Base64.toString(value)) as unknown
    return parsePaymentRequiredEnvelope(parsed)
  } catch {
    throw new HeaderCodec.InvalidJsonHeaderError()
  }
}

/** Encodes an x402 payment payload for the `PAYMENT-SIGNATURE` header. */
export const encodePaymentSignature: (paymentPayload: PaymentPayload) => string =
  paymentSignature.encode

/** Decodes an x402 `PAYMENT-SIGNATURE` header value. */
export const decodePaymentSignature: (value: string) => PaymentPayload = paymentSignature.decode

/** Encodes an x402 settlement response for the `PAYMENT-RESPONSE` header. */
export const encodePaymentResponse: (paymentResponse: SettleResponse) => string =
  paymentResponse.encode

/** Decodes an x402 `PAYMENT-RESPONSE` header value. */
export const decodePaymentResponse: (value: string) => SettleResponse = paymentResponse.decode

const parsePaymentRequiredEnvelope = (value: unknown): PaymentRequiredEnvelope => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HeaderCodec.InvalidJsonHeaderError()

  const record = value as Record<string, unknown>
  if (record.x402Version !== 2 || !Array.isArray(record.accepts))
    throw new HeaderCodec.InvalidJsonHeaderError()

  const resource = ResourceInfoSchema.parse(record.resource)
  const extensions =
    record.extensions === undefined ? undefined : ExtensionsSchema.parse(record.extensions)

  return {
    accepts: record.accepts,
    ...(extensions ? { extensions } : {}),
    resource,
    x402Version: 2,
  }
}
