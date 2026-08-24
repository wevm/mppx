import type {
  HTTPRequestContext,
  SkipHandlerDirective,
  x402ResourceServer,
} from '@x402/core/server'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { formatUnits, getAddress, isAddress } from 'viem'

import { VerificationFailedError } from '../../Errors.js'
import { evm } from '../../evm/server/Methods.js'
import { eip3009 } from '../../evm/Types.js'
import type * as EvmTypes from '../../evm/Types.js'
import * as Expires from '../../Expires.js'
import * as Mppx from '../../server/Mppx.js'
import { tempo } from '../../tempo/server/Methods.js'
import * as Types from '../../x402/Types.js'

/** Configuration shared by the x402 compatibility integrations. */
export type Config = {
  /** Realm used in MPP challenges. Defaults using the normal mppx realm resolution. */
  realm?: string | undefined
  /** Secret used to bind MPP challenge IDs to their contents. Must contain at least 32 bytes. */
  secretKey: string
  /** Existing x402 resource server used for requirement metadata, verification, and settlement. */
  server: x402ResourceServer
}

/** Creates a native MPP handler backed by a compatible x402 EVM requirement. */
export function createHandler(parameters: {
  config: Config
  context: HTTPRequestContext
  paymentRequired: PaymentRequired
}) {
  const requirement = selectRequirement(parameters.paymentRequired, parameters.config.server)
  if (!requirement) return undefined

  const chainId = parseChainId(requirement.network)
  if (chainId === undefined) return undefined
  let skipHandlerResponse: Response | undefined
  const decimals = parameters.config.server.getAssetDecimalsForRequirements(requirement)
  const evmMethod = evm.charge({
    authorization: {
      name: requirement.extra.name as string,
      version: requirement.extra.version as string,
    },
    chainId,
    currency: normalizeAddress(requirement.asset),
    decimals,
    recipient: normalizeAddress(requirement.payTo),
    settle: async ({ payload }) => {
      const result = await settle({
        context: parameters.context,
        payload,
        paymentRequired: parameters.paymentRequired,
        requirement,
        server: parameters.config.server,
      })
      skipHandlerResponse = result.skipHandlerResponse
      return { reference: result.reference }
    },
  })
  const payment = Mppx.create({
    methods: [tempo.charge({ recipient: normalizeAddress(requirement.payTo) }), evmMethod],
    ...(parameters.config.realm ? { realm: parameters.config.realm } : {}),
    secretKey: parameters.config.secretKey,
  })
  const options = {
    amount: formatUnits(BigInt(requirement.amount), decimals),
    ...(parameters.paymentRequired.resource.description
      ? { description: parameters.paymentRequired.resource.description }
      : {}),
    expires: Expires.seconds(requirement.maxTimeoutSeconds),
    scope: parameters.paymentRequired.resource.url,
  }
  const handler = payment.compose([payment.tempo.charge, options], [payment.evm.charge, options])
  return async (request: Request) => ({
    payment: await handler(request),
    skipHandlerResponse,
  })
}

/** Selects an extension-free EIP-3009 requirement that can be represented without semantic loss. */
export function selectRequirement(
  paymentRequired: PaymentRequired,
  server: x402ResourceServer,
): PaymentRequirements | undefined {
  if (paymentRequired.extensions && Object.keys(paymentRequired.extensions).length > 0)
    return undefined
  return paymentRequired.accepts.find((requirement) => {
    if (requirement.scheme !== 'exact') return false
    if (parseChainId(requirement.network) === undefined) return false
    const assetTransferMethod =
      requirement.extra?.assetTransferMethod ??
      server.getRegisteredScheme(requirement.network, requirement.scheme)
        ?.defaultAssetTransferMethod
    if (assetTransferMethod !== eip3009) return false
    if (!isAddress(requirement.asset, { strict: false })) return false
    if (!isAddress(requirement.payTo, { strict: false })) return false
    return (
      typeof requirement.extra?.name === 'string' &&
      typeof requirement.extra?.version === 'string' &&
      /^\d+$/.test(requirement.amount)
    )
  })
}

function normalizeAddress(address: string) {
  return getAddress(address.toLowerCase())
}

/** Verifies and settles an MPP authorization through the official x402 resource server. */
async function settle(parameters: {
  context: HTTPRequestContext
  payload: EvmTypes.AuthorizationPayload
  paymentRequired: PaymentRequired
  requirement: PaymentRequirements
  server: x402ResourceServer
}) {
  const paymentPayload = toPaymentPayload(parameters)
  const transportContext = { request: parameters.context }
  const verified = await parameters.server.verifyPayment(
    paymentPayload,
    parameters.requirement,
    parameters.paymentRequired.extensions,
    transportContext,
  )
  if (!verified.isValid)
    throw new VerificationFailedError({
      reason: verified.invalidMessage ?? verified.invalidReason ?? 'x402 verification failed',
    })

  const settled = await parameters.server.settlePayment(
    paymentPayload,
    parameters.requirement,
    parameters.paymentRequired.extensions,
    transportContext,
  )
  if (!settled.success)
    throw new VerificationFailedError({
      reason: settled.errorMessage ?? settled.errorReason ?? 'x402 settlement failed',
    })
  return {
    reference: settled.transaction,
    ...(verified.skipHandler
      ? { skipHandlerResponse: responseFromSkipHandler(verified.skipHandler) }
      : {}),
  }
}

/** Converts an MPP EIP-3009 authorization to the x402 facilitator payload shape. */
function toPaymentPayload(parameters: {
  payload: EvmTypes.AuthorizationPayload
  paymentRequired: PaymentRequired
  requirement: PaymentRequirements
}): PaymentPayload {
  return {
    accepted: parameters.requirement,
    payload: {
      authorization: {
        from: parameters.payload.from,
        nonce: parameters.payload.nonce,
        to: parameters.payload.to,
        validAfter: parameters.payload.validAfter,
        validBefore: parameters.payload.validBefore,
        value: parameters.payload.value,
      },
      signature: parameters.payload.signature,
    },
    resource: parameters.paymentRequired.resource,
    x402Version: 2,
  }
}

function responseFromSkipHandler(directive: SkipHandlerDirective): Response {
  const contentType = directive.contentType ?? 'application/json'
  const value = directive.body ?? {}
  const body = contentType.toLowerCase().includes('json')
    ? JSON.stringify(value)
    : (value as BodyInit)
  return new Response(body, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': contentType,
    },
    status: 200,
  })
}

function parseChainId(network: string): number | undefined {
  if (!network.startsWith(Types.evmNetworkPrefix)) return undefined
  const reference = network.slice(Types.evmNetworkPrefix.length)
  if (!/^\d+$/.test(reference)) return undefined
  const chainId = Number(reference)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return undefined
  return chainId
}
