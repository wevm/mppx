import { isDeepStrictEqual } from 'node:util'

import { getAddress, recoverTypedDataAddress } from 'viem'

import * as Challenge from '../../Challenge.js'
import type * as Credential from '../../Credential.js'
import * as Credential_ from '../../Credential.js'
import { VerificationFailedError } from '../../Errors.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as ServerTransport from '../../server/Transport.js'
import * as x402_Header from '../../x402/Header.js'
import * as x402_Types from '../../x402/Types.js'
import * as Assets from '../Assets.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates an EVM charge server method.
 *
 * Speaks the native Payment-auth `evm/charge` wire format.
 */
export function charge(
  parameters: charge.NativeConfig,
): Method.Server<typeof Methods.charge, charge.Defaults>
export function charge(parameters: charge.NativeConfig): Method.AnyServer {
  const config = resolveConfig(parameters)
  const transport = httpTransport(config)

  return Method.toServer<typeof Methods.charge, charge.Defaults, typeof transport>(Methods.charge, {
    defaults: {
      chainId: config.chainId,
      currency: config.currency,
      credentialTypes: ['authorization'],
      decimals: config.decimals,
      recipient: config.recipient,
    },
    transport,
    async verify({ credential, envelope }) {
      const payload = credential.payload as Types.AuthorizationPayload
      const request = credential.challenge.request as Types.ChargeRequest
      const chainId = request.methodDetails.chainId
      const isX402Credential = envelope?.capturedRequest.headers.has(
        x402_Types.paymentSignatureHeader,
      )

      if (!request.methodDetails.credentialTypes?.includes('authorization')) {
        throw new VerificationFailedError({
          reason: 'EVM authorization credentials are not supported for this challenge',
        })
      }

      if (request.methodDetails.splits?.length) {
        throw new VerificationFailedError({
          reason: 'EVM authorization credentials do not support splits',
        })
      }

      assertAddressEqual(payload.to, request.recipient, 'EVM authorization recipient mismatch')
      if (payload.value !== request.amount)
        throw new VerificationFailedError({ reason: 'EVM authorization amount mismatch' })
      if (!isX402Credential && payload.nonce !== Types.challengeHash(credential.challenge))
        throw new VerificationFailedError({ reason: 'EVM authorization challenge hash mismatch' })
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (BigInt(payload.validAfter) > now)
        throw new VerificationFailedError({ reason: 'EVM authorization is not valid yet' })
      if (BigInt(payload.validBefore) <= now)
        throw new VerificationFailedError({ reason: 'EVM authorization has expired' })

      const signer = await recoverTypedDataAddress({
        domain: Types.authorizationDomain({
          authorization: config.authorization,
          chainId,
          currency: request.currency as `0x${string}`,
        }),
        message: {
          from: getAddress(payload.from),
          nonce: payload.nonce as `0x${string}`,
          to: getAddress(payload.to),
          validAfter: BigInt(payload.validAfter),
          validBefore: BigInt(payload.validBefore),
          value: BigInt(payload.value),
        },
        primaryType: 'TransferWithAuthorization',
        signature: payload.signature as `0x${string}`,
        types: Types.authorizationTypes,
      })
      assertAddressEqual(signer, payload.from, 'EVM authorization signature mismatch')

      const source = Types.toSource({ address: getAddress(payload.from), chainId })
      if (credential.source && credential.source !== source) {
        throw new VerificationFailedError({ reason: 'EVM authorization source mismatch' })
      }

      const settled = await config.settle({
        credential,
        payload,
        request,
        source,
      })

      return Receipt.from({
        chainId,
        challengeId: credential.challenge.id,
        method: Types.paymentMethod,
        reference: settled.reference,
        status: 'success',
        timestamp: settled.timestamp ?? new Date().toISOString(),
      })
    },
  })
}

export declare namespace charge {
  type Parameters = NativeConfig
  type Native = Method.Server<typeof Methods.charge, Defaults>

  type NativeConfig = BaseConfig & CurrencyConfig & RecipientConfig

  type BaseConfig = {
    /** EIP-3009 token domain metadata. Required for custom currency addresses; inferred for known assets. */
    authorization?: Types.AuthorizationConfig | undefined
    /** EVM chain ID. Required for custom currency addresses; inferred for known assets. */
    chainId?: number | undefined
    /** Token decimal places. Required for custom currency addresses; inferred for known assets. */
    decimals?: number | undefined
    /** Facilitator client or base URL used for automatic authorization settlement. */
    facilitator?: string | x402_Types.Facilitator | undefined
    /** Maximum time in seconds allowed for payment completion. @default 300 */
    maxTimeoutSeconds?: number | undefined
    /** Custom settlement override. If omitted, `facilitator` is used. */
    settle?: SettleAuthorization | undefined
  }

  type CurrencyConfig =
    | {
        /** Token contract address or known EVM asset metadata. */
        currency: `0x${string}` | Assets.KnownAsset
      }
    | {
        /** Legacy alias for `currency`. */
        asset: `0x${string}` | Assets.KnownAsset
      }

  type RecipientConfig =
    | {
        /** Recipient wallet address. */
        recipient: `0x${string}`
      }
    | {
        /** Legacy alias for `recipient`. */
        payTo: `0x${string}`
      }

  type RouteOptions = {
    /** Required display-unit token amount. */
    amount: string
    /** Optional human-readable payment description. */
    description?: string | undefined
    /** Optional external correlation ID. */
    externalId?: string | undefined
  }

  type SettleAuthorization = (parameters: {
    credential: Credential.Credential<Types.AuthorizationPayload>
    payload: Types.AuthorizationPayload
    request: Types.ChargeRequest
    source: ReturnType<typeof Types.toSource>
  }) => Promise<{
    reference: string
    timestamp?: string | undefined
  }>

  type Defaults = {
    chainId: number
    currency: `0x${string}`
    credentialTypes: ['authorization']
    decimals: number
    recipient: `0x${string}`
  }
}

type ResolvedConfig = {
  authorization: Types.AuthorizationConfig
  chainId: number
  currency: `0x${string}`
  decimals: number
  maxTimeoutSeconds: number
  recipient: `0x${string}`
  settle: charge.SettleAuthorization
}

function httpTransport(config: ResolvedConfig) {
  const base = ServerTransport.http()

  return ServerTransport.from<Request, Response>({
    name: 'evm-http',

    captureRequest: base.captureRequest,

    getCredential(request) {
      const authorization = base.getCredential(request)
      if (authorization) return authorization

      const paymentSignature = request.headers.get(x402_Types.paymentSignatureHeader)
      if (!paymentSignature) return null
      const paymentPayload = x402_Header.decodePaymentSignature(paymentSignature)

      return Credential_.from({
        challenge: Challenge.from({
          id: 'x402-pending',
          intent: Types.chargeIntent,
          method: Types.paymentMethod,
          realm: 'x402',
          request: {},
        }),
        payload: paymentPayload,
      })
    },

    bindCredential({ challenge, credential, input }) {
      const paymentPayload = parseX402PaymentPayload(credential.payload)
      if (!paymentPayload) return credential

      const paymentRequirements = toX402PaymentRequirements(
        challenge.request as Types.ChargeRequest,
        config,
      )
      if (!isDeepStrictEqual(paymentPayload.accepted, paymentRequirements))
        throw new VerificationFailedError({
          reason: 'x402 payment payload does not match route requirements',
        })

      const expectedResource = { url: input.url }
      if (!isDeepStrictEqual(paymentPayload.resource, expectedResource))
        throw new VerificationFailedError({
          reason: 'x402 payment payload resource does not match route resource',
        })

      const payload = x402PayloadToAuthorization(paymentPayload)

      return Credential_.from({
        challenge,
        payload,
        source: Types.toSource({
          address: getAddress(payload.from),
          chainId: (challenge.request as Types.ChargeRequest).methodDetails.chainId,
        }),
      })
    },

    async respondChallenge(options) {
      const response = await base.respondChallenge(options)
      const headers = new Headers(response.headers)
      const request = options.challenge.request as Types.ChargeRequest
      headers.set(
        x402_Types.paymentRequiredHeader,
        x402_Header.encodePaymentRequired({
          accepts: [toX402PaymentRequirements(request, config)],
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

    respondReceipt(options) {
      const response = base.respondReceipt(options)
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
  })
}

function resolveConfig(config: charge.NativeConfig): ResolvedConfig {
  const currency = 'currency' in config ? config.currency : config.asset
  const recipient = 'recipient' in config ? config.recipient : config.payTo
  let address: `0x${string}`
  let authorization = config.authorization
  let chainId = config.chainId
  let decimals = config.decimals

  if (Assets.isAsset(currency)) {
    address = currency.address
    chainId ??= Number(currency.network.slice('eip155:'.length))
    decimals ??= currency.decimals
    if (currency.transfer.type === Types.eip3009) {
      authorization ??= {
        name: currency.transfer.name,
        version: currency.transfer.version,
      }
    }
  } else {
    address = currency
  }

  if (!authorization) throw new Error('EVM authorization requires `authorization` metadata.')
  if (chainId === undefined) throw new Error('EVM authorization requires `chainId`.')
  if (decimals === undefined) throw new Error('EVM authorization requires `decimals`.')

  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 300
  const settle =
    config.settle ??
    (config.facilitator
      ? facilitatorSettlement({
          authorization,
          facilitator: resolveFacilitator(config.facilitator),
          maxTimeoutSeconds,
        })
      : undefined)
  if (!settle) throw new Error('EVM authorization requires `facilitator` or `settle`.')

  return {
    authorization,
    chainId,
    currency: getAddress(address),
    decimals,
    maxTimeoutSeconds,
    recipient: getAddress(recipient),
    settle,
  }
}

function assertAddressEqual(actual: string, expected: string, reason: string) {
  if (getAddress(actual) === getAddress(expected)) return
  throw new VerificationFailedError({ reason })
}

function facilitatorSettlement(parameters: {
  authorization: Types.AuthorizationConfig
  facilitator: x402_Types.Facilitator
  maxTimeoutSeconds: number
}): charge.SettleAuthorization {
  const { facilitator, maxTimeoutSeconds } = parameters
  return async ({ payload, request }) => {
    const paymentRequirements: x402_Types.PaymentRequirements = {
      ...toX402PaymentRequirements(request, { ...parameters, maxTimeoutSeconds }),
    }
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

function toX402PaymentRequirements(
  request: Types.ChargeRequest,
  config: Pick<ResolvedConfig, 'authorization' | 'maxTimeoutSeconds'>,
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

function parseX402PaymentPayload(payload: unknown): x402_Types.PaymentPayload | undefined {
  const parsed = x402_Types.PaymentPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

function x402PayloadToAuthorization(
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

function resolveFacilitator(facilitator: string | x402_Types.Facilitator): x402_Types.Facilitator {
  if (typeof facilitator === 'object' && facilitator !== null) return facilitator
  if (typeof facilitator === 'string') return httpFacilitator(facilitator)
  throw new Error('EVM authorization requires `facilitator` or `settle`.')
}

function httpFacilitator(url: string): x402_Types.Facilitator {
  const base = url.replace(/\/$/, '')
  return {
    async verify(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/verify`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return x402_Types.VerifyResponseSchema.parse(await response.json())
    },
    async settle(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/settle`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return x402_Types.SettleResponseSchema.parse(await response.json())
    },
  }
}
