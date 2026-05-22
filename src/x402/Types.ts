import * as z from '../zod.js'

export const versions = [2] as const
export const schemes = ['exact'] as const
export const assetTransferMethods = ['eip3009', 'permit2'] as const
export const evmNetworkPrefix = 'eip155:' as const

/** x402 protocol version supported by this package. */
export type Version = 2

/** x402 scheme supported by this package. */
export type Scheme = (typeof schemes)[number]

/** x402 exact EVM asset transfer method. */
export type AssetTransferMethod = (typeof assetTransferMethods)[number]

/** CAIP-2 EVM network identifier. */
export type EvmNetwork = `${typeof evmNetworkPrefix}${number}`

/** HTTP header carrying a base64-encoded x402 payment-required response. */
export const paymentRequiredHeader = 'PAYMENT-REQUIRED'

/** HTTP header carrying a base64-encoded x402 payment payload. */
export const paymentSignatureHeader = 'PAYMENT-SIGNATURE'

/** HTTP header carrying a base64-encoded x402 settlement response. */
export const paymentResponseHeader = 'PAYMENT-RESPONSE'

const nonEmptyString = z.string().check(z.minLength(1))
const positiveNumber = z.number().check(z.refine((value) => value > 0, 'Must be positive'))
const atomicAmount = z.string().check(z.regex(/^\d+$/, 'Invalid atomic amount'))
const address = z.address()
const evmNetwork = z
  .string()
  .check(
    z.regex(new RegExp(`^${evmNetworkPrefix}\\d+$`), 'Invalid EVM CAIP-2 network'),
  ) as z.ZodMiniType<EvmNetwork>

/** Describes the protected resource in x402 v2 payment-required responses. */
export const ResourceInfoSchema = z.object({
  description: z.optional(z.string()),
  iconUrl: z.optional(z.string()),
  mimeType: z.optional(z.string()),
  serviceName: z.optional(z.string()),
  tags: z.optional(z.array(z.string())),
  url: nonEmptyString,
})

/** Describes the protected resource in x402 v2 payment-required responses. */
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>

/** Public transfer configuration for exact EVM payments. */
export const ExactTransferSchema = z.discriminatedUnion('type', [
  z.object({
    name: nonEmptyString,
    type: z.literal('eip3009'),
    version: nonEmptyString,
  }),
  z.object({
    name: z.optional(z.string()),
    type: z.literal('permit2'),
    version: z.optional(z.string()),
  }),
])

/** Public EIP-3009 transfer configuration for exact EVM payments. */
export type ExactEip3009Transfer = Extract<z.infer<typeof ExactTransferSchema>, { type: 'eip3009' }>

/** Public Permit2 transfer configuration for exact EVM payments. */
export type ExactPermit2Transfer = Extract<z.infer<typeof ExactTransferSchema>, { type: 'permit2' }>

/** Public transfer configuration for exact EVM payments. */
export type ExactTransfer = z.infer<typeof ExactTransferSchema>

/** Known asset metadata used to derive x402 wire `extra` fields. */
export type Asset = {
  address: `0x${string}`
  decimals: number
  transfer: ExactTransfer
}

/** Public exact EVM route request accepted by `mppx` handlers. */
export type ExactRequest = PaymentRequirements & {
  resource?: ResourceInfo | undefined
}

/** Public exact EVM route input before it is converted to x402 wire requirements. */
export const ExactRequestInputSchema = z.object({
  amount: atomicAmount,
  asset: address,
  maxTimeoutSeconds: positiveNumber,
  network: evmNetwork,
  payTo: address,
  resource: z.optional(ResourceInfoSchema),
  transfer: ExactTransferSchema,
})

/** Public exact EVM route input before it is converted to x402 wire requirements. */
export type ExactRequestInput = z.infer<typeof ExactRequestInputSchema>

/** x402 v2 payment requirements for the `exact` scheme. */
export const PaymentRequirementsSchema = z.object({
  amount: atomicAmount,
  asset: nonEmptyString,
  extra: z.optional(z.record(z.string(), z.unknown())),
  maxTimeoutSeconds: positiveNumber,
  network: evmNetwork,
  payTo: nonEmptyString,
  scheme: z.enum(schemes),
})

/** x402 v2 payment requirements for the `exact` scheme. */
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>

/** x402 v2 payment-required response. */
export const PaymentRequiredSchema = z.object({
  accepts: z.array(PaymentRequirementsSchema).check(z.minLength(1)),
  error: z.optional(z.string()),
  extensions: z.optional(z.record(z.string(), z.unknown())),
  resource: ResourceInfoSchema,
  x402Version: z.literal(2),
})

/** x402 v2 payment-required response. */
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>

/** EIP-3009 transferWithAuthorization payload for exact EVM payments. */
export const ExactEip3009PayloadSchema = z.object({
  authorization: z.object({
    from: address,
    nonce: z.hash(),
    to: address,
    validAfter: atomicAmount,
    validBefore: atomicAmount,
    value: atomicAmount,
  }),
  signature: z.signature(),
})

/** EIP-3009 transferWithAuthorization payload for exact EVM payments. */
export type ExactEip3009Payload = z.infer<typeof ExactEip3009PayloadSchema>

/** Permit2 payload for exact EVM payments. */
export const ExactPermit2PayloadSchema = z.object({
  permit2Authorization: z.object({
    deadline: atomicAmount,
    from: address,
    nonce: atomicAmount,
    permitted: z.object({
      amount: atomicAmount,
      token: address,
    }),
    spender: address,
    witness: z.object({
      to: address,
      validAfter: atomicAmount,
    }),
  }),
  signature: z.signature(),
})

/** Permit2 payload for exact EVM payments. */
export type ExactPermit2Payload = z.infer<typeof ExactPermit2PayloadSchema>

/** Exact EVM payment payload body. */
export const ExactPayloadSchema = z.union([ExactEip3009PayloadSchema, ExactPermit2PayloadSchema])

/** Exact EVM payment payload body. */
export type ExactPayload = z.infer<typeof ExactPayloadSchema>

/** x402 v2 payment payload. */
export const PaymentPayloadSchema = z.object({
  accepted: PaymentRequirementsSchema,
  extensions: z.optional(z.record(z.string(), z.unknown())),
  payload: ExactPayloadSchema,
  resource: z.optional(ResourceInfoSchema),
  x402Version: z.literal(2),
})

/** x402 v2 payment payload. */
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>

/** Facilitator verification response. */
export const VerifyResponseSchema = z.object({
  extensions: z.optional(z.record(z.string(), z.unknown())),
  extra: z.optional(z.record(z.string(), z.unknown())),
  invalidMessage: z.optional(z.string()),
  invalidReason: z.optional(z.string()),
  isValid: z.boolean(),
  payer: z.optional(z.string()),
})

/** Facilitator verification response. */
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>

/** Facilitator settlement response and x402 `PAYMENT-RESPONSE` body. */
export const SettleResponseSchema = z.object({
  amount: z.optional(atomicAmount),
  errorMessage: z.optional(z.string()),
  errorReason: z.optional(z.string()),
  extensions: z.optional(z.record(z.string(), z.unknown())),
  extra: z.optional(z.record(z.string(), z.unknown())),
  network: nonEmptyString,
  payer: z.optional(z.string()),
  success: z.boolean(),
  transaction: z.string(),
})

/** Facilitator settlement response and x402 `PAYMENT-RESPONSE` body. */
export type SettleResponse = z.infer<typeof SettleResponseSchema>

/** x402 facilitator client interface used by server exact config. */
export type Facilitator = {
  settle: (
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ) => Promise<SettleResponse>
  verify: (
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ) => Promise<VerifyResponse>
}

/** Converts public transfer config into x402 wire `extra` fields. */
export function transferToExtra(transfer: ExactTransfer): Record<string, unknown> {
  return {
    assetTransferMethod: transfer.type,
    ...('name' in transfer && transfer.name !== undefined ? { name: transfer.name } : {}),
    ...('version' in transfer && transfer.version !== undefined
      ? { version: transfer.version }
      : {}),
  }
}

/** Extracts x402 `PaymentRequirements` from a canonical exact request. */
export function toPaymentRequirements(request: ExactRequest): PaymentRequirements {
  const { resource: _resource, ...paymentRequirements } = request
  return PaymentRequirementsSchema.parse(paymentRequirements)
}
