import * as HeaderCodec from '../internal/HeaderCodec.js'
import {
  PaymentPayloadSchema,
  PaymentRequiredSchema,
  SettleResponseSchema,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
} from './Types.js'

const paymentRequired = HeaderCodec.createJson(PaymentRequiredSchema)
const paymentSignature = HeaderCodec.createJson(PaymentPayloadSchema)
const paymentResponse = HeaderCodec.createJson(SettleResponseSchema)

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
