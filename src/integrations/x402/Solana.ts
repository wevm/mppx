import type { HTTPRequestContext, x402ResourceServer } from '@x402/core/server'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'

import { VerificationFailedError } from '../../Errors.js'
import * as Expires from '../../Expires.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as Mppx from '../../server/Mppx.js'
import * as z from '../../zod.js'
import type { Config } from './Evm.js'

/**
 * Solana clusters by CAIP-2 network, named as the `solana/charge` method names them
 * (`methodDetails.network`).
 */
export const networks = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'mainnet',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'devnet',
} as const satisfies Record<string, string>

const base58 = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address'))

/**
 * The fee-sponsored, server-broadcast subset of the `solana/charge` method (the same wire
 * format as `@solana/mpp`'s `solana.charge`), so a client that pays `solana/charge` pays it.
 * Only what an x402 `exact` facilitator can settle is offered: an SPL transfer the client
 * partially signs, with the facilitator as fee payer.
 */
export const charge = Method.from({
  name: 'solana',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({
        transaction: z.string().check(z.minLength(1)),
        type: z.literal('transaction'),
      }),
    },
    request: z.object({
      amount: z.string().check(z.regex(/^\d+$/, 'Invalid atomic amount')),
      currency: base58,
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.object({
        decimals: z.number(),
        feePayer: z.literal(true),
        feePayerKey: base58,
        network: z.enum(['devnet', 'mainnet']),
      }),
      recipient: base58,
    }),
  },
})

/**
 * Creates a native `solana/charge` MPP handler backed by a compatible x402 Solana `exact`
 * requirement. The client's partially signed transaction is verified and settled by the route's
 * x402 facilitator, exactly as an x402 payment would be.
 */
export function createHandler(parameters: {
  config: Config
  context: HTTPRequestContext
  paymentRequired: PaymentRequired
}) {
  const requirement = selectRequirement(parameters.paymentRequired)
  if (!requirement) return undefined

  const decimals = parameters.config.server.getAssetDecimalsForRequirements(requirement)
  const method = Method.toServer(charge, {
    async verify({ credential }) {
      const reference = await settle({
        context: parameters.context,
        paymentRequired: parameters.paymentRequired,
        requirement,
        server: parameters.config.server,
        transaction: credential.payload.transaction,
      })
      return Receipt.from({
        method: charge.name,
        reference,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
  const payment = Mppx.create({
    methods: [method],
    ...(parameters.config.realm ? { realm: parameters.config.realm } : {}),
    secretKey: parameters.config.secretKey,
  })
  const description = parameters.paymentRequired.resource.description
  const options = {
    amount: requirement.amount,
    currency: requirement.asset,
    ...(description ? { description } : {}),
    expires: Expires.seconds(requirement.maxTimeoutSeconds),
    methodDetails: {
      decimals,
      feePayer: true as const,
      feePayerKey: requirement.extra.feePayer as string,
      network: networks[requirement.network as keyof typeof networks],
    },
    recipient: requirement.payTo,
    scope: parameters.paymentRequired.resource.url,
  }
  const handler = payment.compose([payment.solana.charge, options])
  return async (request: Request) => ({
    payment: await handler(request),
    skipHandlerResponse: undefined as Response | undefined,
  })
}

/**
 * The first x402 requirement a `solana/charge` credential can satisfy: `exact` on a known
 * Solana cluster, with a facilitator fee payer and no seller memo (a `solana/charge` client does
 * not write x402's `extra.memo`). Routes with x402 extensions are left to x402.
 */
export function selectRequirement(
  paymentRequired: PaymentRequired,
): PaymentRequirements | undefined {
  if (paymentRequired.extensions && Object.keys(paymentRequired.extensions).length > 0)
    return undefined
  return paymentRequired.accepts.find((requirement) => {
    if (requirement.scheme !== 'exact') return false
    if (!(requirement.network in networks)) return false
    if (requirement.extra?.memo !== undefined) return false
    const { feePayer } = requirement.extra ?? {}
    return (
      typeof feePayer === 'string' &&
      base58.safeParse(feePayer).success &&
      base58.safeParse(requirement.asset).success &&
      base58.safeParse(requirement.payTo).success &&
      /^\d+$/.test(requirement.amount)
    )
  })
}

async function settle(parameters: {
  context: HTTPRequestContext
  paymentRequired: PaymentRequired
  requirement: PaymentRequirements
  server: x402ResourceServer
  transaction: string
}) {
  const paymentPayload: PaymentPayload = {
    accepted: parameters.requirement,
    payload: { transaction: parameters.transaction },
    resource: parameters.paymentRequired.resource,
    x402Version: 2,
  }
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
  return settled.transaction
}
