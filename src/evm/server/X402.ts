import { isDeepStrictEqual } from 'node:util'

import { Bytes, Hash } from 'ox'
import { getAddress } from 'viem'

import * as Challenge from '../../Challenge.js'
import type * as Credential from '../../Credential.js'
import * as Credential_ from '../../Credential.js'
import { VerificationFailedError } from '../../Errors.js'
import * as ServerTransport from '../../server/Transport.js'
import * as x402_Header from '../../x402/Header.js'
import * as x402_Facilitator from '../../x402/server/Facilitator.js'
import * as x402_Types from '../../x402/Types.js'
import * as Types from '../Types.js'

const x402Credential = Symbol('mppx.evm.x402Credential')

export type Options = {
  /** Facilitator client or base URL used for x402-compatible settlement. */
  facilitator?: string | x402_Types.Facilitator | undefined
  /** Maximum time in seconds allowed for x402-compatible payment completion. @default 300 */
  maxTimeoutSeconds?: number | undefined
}

export type ResolvedOptions = {
  authorization: Types.AuthorizationConfig
  facilitator?: x402_Types.Facilitator | undefined
  maxTimeoutSeconds: number
}

export type Path = {
  bindCredential: NonNullable<ServerTransport.Http['bindCredential']>
  getCredential: ServerTransport.Http['getCredential']
  respondChallenge: (
    options: Parameters<ServerTransport.Http['respondChallenge']>[0],
    response: Response,
  ) => Response | Promise<Response>
  respondReceipt: (
    options: Parameters<ServerTransport.Http['respondReceipt']>[0],
    response: Response,
  ) => Response
}

/** Resolves optional x402 compatibility options for an EVM charge. */
export function resolveOptions(parameters: {
  authorization: Types.AuthorizationConfig
  options?: Options | undefined
}): ResolvedOptions {
  return {
    authorization: parameters.authorization,
    ...(parameters.options?.facilitator
      ? {
          facilitator: x402_Facilitator.resolve(
            parameters.options.facilitator,
            'EVM authorization x402 requires `facilitator`.',
          ),
        }
      : {}),
    maxTimeoutSeconds: parameters.options?.maxTimeoutSeconds ?? 300,
  }
}

/** Creates the x402 wire path for an EVM charge method. */
export function createPath(config: ResolvedOptions): Path {
  return {
    getCredential(request) {
      const paymentSignature = request.headers.get(x402_Types.paymentSignatureHeader)
      if (!paymentSignature) return null
      const paymentPayload = x402_Header.decodePaymentSignature(paymentSignature)

      return Credential_.from({
        challenge: pendingChallenge(paymentPayload),
        payload: paymentPayload,
      })
    },

    bindCredential({ challenge, credential, input }) {
      const paymentPayload = parsePaymentPayload(credential.payload)
      if (!paymentPayload) return credential

      const request = challenge.request as Types.ChargeRequest
      const paymentRequirements = toPaymentRequirements(request, config)
      if (!isDeepStrictEqual(paymentPayload.accepted, paymentRequirements))
        throw new VerificationFailedError({
          reason: 'x402 payment payload does not match route requirements',
        })

      const expectedResource = { url: input.url }
      if (!isDeepStrictEqual(paymentPayload.resource, expectedResource))
        throw new VerificationFailedError({
          reason: 'x402 payment payload resource does not match route resource',
        })

      const payload = payloadToAuthorization(paymentPayload)

      return markCredential(
        Credential_.from({
          challenge,
          payload,
          source: Types.toSource({
            address: getAddress(payload.from),
            chainId: request.methodDetails.chainId,
          }),
        }),
      )
    },

    respondChallenge(options, response) {
      const headers = new Headers(response.headers)
      const request = options.challenge.request as Types.ChargeRequest
      headers.set(
        x402_Types.paymentRequiredHeader,
        x402_Header.encodePaymentRequired({
          accepts: [toPaymentRequirements(request, config)],
          error:
            options.error?.message ?? `${x402_Types.paymentSignatureHeader} header is required`,
          resource: { url: options.input.url },
          x402Version: 2,
        }),
      )
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      })
    },

    respondReceipt(options, response) {
      if (!options.input.headers.has(x402_Types.paymentSignatureHeader)) return response

      const payload = Types.AuthorizationPayloadSchema.parse(options.credential.payload)
      const request = options.credential.challenge.request as Types.ChargeRequest
      const headers = new Headers(response.headers)
      headers.set(
        x402_Types.paymentResponseHeader,
        x402_Header.encodePaymentResponse({
          network: Types.networkOf(request.methodDetails.chainId),
          payer: payload.from,
          success: true,
          transaction: options.receipt.reference,
        }),
      )
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      })
    },
  }
}

/** Settles a verified EVM authorization through an x402 facilitator. */
export function settleWithFacilitator(parameters: ResolvedOptions): SettleWithFacilitator {
  const { facilitator, maxTimeoutSeconds } = parameters
  if (!facilitator) throw new Error('EVM authorization x402 requires `facilitator`.')

  return async ({ payload, request }) => {
    const paymentRequirements = toPaymentRequirements(request, {
      ...parameters,
      maxTimeoutSeconds,
    })
    const paymentPayload: x402_Types.PaymentPayload = {
      accepted: paymentRequirements,
      payload: {
        authorization: {
          from: payload.from,
          nonce: payload.nonce,
          to: payload.to,
          validAfter: payload.validAfter,
          validBefore: payload.validBefore,
          value: payload.value,
        },
        signature: payload.signature,
      },
      x402Version: 2,
    }

    const verified = await facilitator.verify(paymentPayload, paymentRequirements)
    if (!verified.isValid)
      throw new VerificationFailedError({
        reason:
          verified.invalidMessage ?? verified.invalidReason ?? 'EVM facilitator verify failed',
      })

    const settled = await facilitator.settle(paymentPayload, paymentRequirements)
    if (!settled.success)
      throw new VerificationFailedError({
        reason: settled.errorMessage ?? settled.errorReason ?? 'EVM facilitator settlement failed',
      })

    return {
      reference: settled.transaction,
    }
  }
}

export type SettleWithFacilitator = (parameters: {
  credential: Credential.Credential<Types.AuthorizationPayload>
  payload: Types.AuthorizationPayload
  request: Types.ChargeRequest
  source: ReturnType<typeof Types.toSource>
}) => Promise<{
  reference: string
  timestamp?: string | undefined
}>

/** Returns whether a credential was converted from an x402 payment payload. */
export function isCredential(credential: Credential.Credential): boolean {
  return (credential as { [x402Credential]?: true })[x402Credential] === true
}

/** Converts a native EVM charge request to x402 exact payment requirements. */
export function toPaymentRequirements(
  request: Types.ChargeRequest,
  config: Pick<ResolvedOptions, 'authorization' | 'maxTimeoutSeconds'>,
): x402_Types.PaymentRequirements {
  return {
    amount: request.amount,
    asset: request.currency,
    extra: {
      assetTransferMethod: Types.eip3009,
      name: config.authorization.name,
      version: config.authorization.version,
    },
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    network: Types.networkOf(request.methodDetails.chainId),
    payTo: request.recipient,
    scheme: 'exact',
  }
}

/** Parses an unknown payload as an x402 payment payload when possible. */
export function parsePaymentPayload(payload: unknown): x402_Types.PaymentPayload | undefined {
  const parsed = x402_Types.PaymentPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

/** Converts an x402 EIP-3009 payment payload to the native EVM authorization payload. */
export function payloadToAuthorization(
  paymentPayload: x402_Types.PaymentPayload,
): Types.AuthorizationPayload {
  if (!('authorization' in paymentPayload.payload))
    throw new VerificationFailedError({
      reason: 'EVM charge only supports x402 EIP-3009 authorization payloads',
    })

  return Types.AuthorizationPayloadSchema.parse({
    ...paymentPayload.payload.authorization,
    signature: paymentPayload.payload.signature,
    type: 'authorization',
  })
}

function pendingChallenge(paymentPayload: x402_Types.PaymentPayload) {
  // The route challenge is built after request normalization in bindCredential().
  // Until then, this deterministic local ID only carries the x402 payload through
  // the standard credential pipeline; it is never HMAC-verified.
  return Challenge.from({
    id: pendingChallengeId(paymentPayload),
    intent: Types.chargeIntent,
    method: Types.paymentMethod,
    realm: 'x402',
    request: paymentPayload.accepted,
  })
}

function pendingChallengeId(paymentPayload: x402_Types.PaymentPayload): string {
  const hash = Hash.sha256(Bytes.fromString(JSON.stringify(paymentPayload)), { as: 'Hex' })
  return `${x402_Types.syntheticChallengeIdPrefix}${hash}`
}

function markCredential<const credential extends Credential.Credential>(
  credential: credential,
): credential {
  Object.defineProperty(credential, x402Credential, {
    enumerable: true,
    value: true,
  })
  return credential
}
