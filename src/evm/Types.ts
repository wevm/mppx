import { Bytes, Hash } from 'ox'

import * as z from '../zod.js'

/** Payment method name for Payment-auth EVM challenges. */
export const paymentMethod = 'evm' as const

/** Payment intent name for one-time EVM charges. */
export const chargeIntent = 'charge' as const

/** CAIP-2 namespace prefix for EVM networks. */
export const evmNetworkPrefix = 'eip155:' as const

/** EIP-3009 transfer authorization method identifier. */
export const eip3009 = 'eip3009' as const

/** EVM charge credential types supported by this package. */
export const credentialTypes = ['authorization'] as const

const atomicAmount = z.string().check(z.regex(/^\d+$/, 'Invalid atomic amount'))

/** EIP-3009 domain metadata for `transferWithAuthorization` signatures. */
export const AuthorizationConfigSchema = z.object({
  name: z.string().check(z.minLength(1)),
  version: z.string().check(z.minLength(1)),
})
export type AuthorizationConfig = z.infer<typeof AuthorizationConfigSchema>

/** CAIP-2 EVM network identifier. */
export type EvmNetwork = `${typeof evmNetworkPrefix}${number}`

/** EVM-specific charge method details. */
export const MethodDetailsSchema = z.object({
  chainId: z.number(),
  credentialTypes: z.optional(z.array(z.enum(credentialTypes)).check(z.minLength(1))),
  decimals: z.optional(z.number()),
  permit2Address: z.optional(z.address()),
  splits: z.optional(
    z.array(
      z.object({
        amount: atomicAmount,
        recipient: z.address(),
      }),
    ),
  ),
})
export type MethodDetails = z.infer<typeof MethodDetailsSchema>

/** Canonical Payment-auth EVM charge request. */
export const ChargeRequestSchema = z.object({
  amount: atomicAmount,
  currency: z.address(),
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  methodDetails: MethodDetailsSchema,
  recipient: z.address(),
})
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>

/** Public route input before display-unit amounts are converted to atomic units. */
export const ChargeRequestInputSchema = z.object({
  amount: z.amount(),
  chainId: z.number(),
  currency: z.address(),
  credentialTypes: z.optional(z.array(z.enum(credentialTypes)).check(z.minLength(1))),
  decimals: z.number(),
  description: z.optional(z.string()),
  externalId: z.optional(z.string()),
  permit2Address: z.optional(z.address()),
  recipient: z.address(),
  splits: z.optional(
    z.array(
      z.object({
        amount: atomicAmount,
        recipient: z.address(),
      }),
    ),
  ),
})
export type ChargeRequestInput = z.infer<typeof ChargeRequestInputSchema>

/** Payment-auth EVM authorization credential payload. */
export const AuthorizationPayloadSchema = z.object({
  from: z.address(),
  nonce: z.hash(),
  signature: z.signature(),
  to: z.address(),
  type: z.literal('authorization'),
  validAfter: atomicAmount,
  validBefore: atomicAmount,
  value: atomicAmount,
})
export type AuthorizationPayload = z.infer<typeof AuthorizationPayloadSchema>

/** Payment-auth EVM charge credential payload. */
export const ChargePayloadSchema = AuthorizationPayloadSchema
export type ChargePayload = z.infer<typeof ChargePayloadSchema>

/** EIP-712 type definition for EIP-3009 `transferWithAuthorization`. */
export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Returns the EIP-712 domain for an EIP-3009 authorization signature. */
export function authorizationDomain(parameters: {
  authorization: AuthorizationConfig
  chainId: number
  currency: `0x${string}`
}) {
  return {
    chainId: parameters.chainId,
    name: parameters.authorization.name,
    verifyingContract: parameters.currency,
    version: parameters.authorization.version,
  } as const
}

/** Computes the Payment-auth EVM challenge hash used as the EIP-3009 nonce. */
export function challengeHash(challenge: { id: string; realm: string }): `0x${string}` {
  return Hash.keccak256(Bytes.fromString(`${challenge.id}${challenge.realm}`), {
    as: 'Hex',
  }) as `0x${string}`
}

/** Converts a chain ID to the CAIP-2 EVM network identifier. */
export function networkOf(chainId: number): EvmNetwork {
  return `${evmNetworkPrefix}${chainId}`
}

/** Formats an EVM address as a did:pkh source identifier. */
export function toSource(parameters: { address: `0x${string}`; chainId: number }) {
  return `did:pkh:eip155:${parameters.chainId}:${parameters.address}` as const
}
