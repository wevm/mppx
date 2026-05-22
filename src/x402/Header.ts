import { Base64 } from 'ox'

import type * as z from '../zod.js'
import {
  PaymentPayloadSchema,
  PaymentRequiredSchema,
  SettleResponseSchema,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
} from './Types.js'

const paymentRequired = createHeaderCodec(PaymentRequiredSchema)
const paymentSignature = createHeaderCodec(PaymentPayloadSchema)
const paymentResponse = createHeaderCodec(SettleResponseSchema)

/** Encodes an x402 payment-required object for the `PAYMENT-REQUIRED` header. */
export const encodePaymentRequired: (paymentRequired: PaymentRequired) => string =
  paymentRequired.encode

/** Decodes an x402 `PAYMENT-REQUIRED` header value. */
export const decodePaymentRequired: (value: string) => PaymentRequired = paymentRequired.decode

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

function createHeaderCodec<const schema extends z.ZodMiniType>(schema: schema) {
  type value = z.output<schema>

  return {
    encode(value: value): string {
      return encodeJson(schema.parse(value))
    },
    decode(value: string): value {
      return schema.parse(decodeJson(value)) as value
    },
  }
}

function encodeJson(value: unknown): string {
  return Base64.fromString(JSON.stringify(value))
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Base64.toString(value))
  } catch {
    throw new Error('Invalid x402 base64 JSON header.')
  }
}
