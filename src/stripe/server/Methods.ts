import crypto from 'node:crypto'
import type * as Method from '../../Method.js'
import * as Mppx from '../../server/Mppx.js'
import * as tempoDefaults from '../../tempo/internal/defaults.js'
import { charge as tempoCharge } from '../../tempo/server/Charge.js'
import { charge as evmCharge } from '../../evm/server/Charge.js'
import * as EvmAssets from '../../evm/Assets.js'
import { charge as charge_ } from './Charge.js'
import { resolveDepositAddress } from './internal/deposit-address.js'
import { recordCryptoPayment } from './internal/record-payment.js'

type TempoNetworkEntry = {
  network: 'tempo'
} & Partial<Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>>

type BaseNetworkEntry = {
  network: 'base'
} & Omit<Parameters<typeof evmCharge>[0], 'currency' | 'recipient'>

type CustomNetworkEntry = {
  network: string
  configure: (address: string) => Method.AnyServer | readonly Method.AnyServer[]
}

type AdditionalNetworkEntry = TempoNetworkEntry | BaseNetworkEntry | CustomNetworkEntry

/**
 * Creates a fully configured Mppx server with all Stripe-supported payment methods.
 *
 * Opinionated: always enables Tempo crypto and SPT (card/link) payments.
 * Pass `additional` to enable more crypto networks (e.g. Base, Solana).
 *
 * Crypto payments are automatically recorded as Stripe PaymentIntents
 * via transaction verification for unified accounting in the Stripe Dashboard.
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/server'
 *
 * const mppx = await stripe({
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   profileId: process.env.STRIPE_PROFILE_ID!,
 * })
 *
 * export async function POST(request: Request) {
 *   const result = await mppx.compose(
 *     ['tempo/charge', { amount: '0.01', description: 'API call' }],
 *     ['stripe/charge', { amount: '0.50', currency: 'usd', decimals: 2, description: 'API call' }],
 *   )(request)
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt(Response.json({ data: '...' }))
 * }
 * ```
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/server'
 * import { solana } from '@solana/mpp/server'
 *
 * const mppx = await stripe({
 *   secretKey: 'sk_...',
 *   profileId: '...',
 *   additional: [
 *     { network: 'base', x402: { facilitator } },
 *     { network: 'solana', configure: (address) => solana.charge({ recipient: address, currency: USDC, decimals: 6 }) },
 *   ],
 * })
 * ```
 */
export async function stripe(parameters: stripe.Parameters) {
  const { secretKey, profileId, paymentMethodTypes, realm } = parameters
  const isTestMode = secretKey.includes('_test_')

  const mppSecretKey = parameters.mppSecretKey
    ?? crypto.createHmac('sha256', secretKey).update('mpp-challenge-signing').digest('base64')

  // Resolve tempo deposit address (required)
  const tempoAddress = await resolveDepositAddress(secretKey, 'tempo')
  if (!tempoAddress) {
    throw new Error(
      'stripe(): failed to resolve Tempo deposit address. Ensure your Stripe account has crypto enabled.',
    )
  }

  // Create tempo method (always on)
  const tempoMethod = tempoCharge({
    currency: (isTestMode
      ? tempoDefaults.tokens.pathUsd
      : tempoDefaults.tokens.usdc) as `0x${string}`,
    recipient: tempoAddress as `0x${string}`,
    ...(isTestMode && { testnet: true }),
  })

  // Create SPT method (always on)
  const sptMethod = stripe.spt({
    secretKey,
    networkId: profileId,
    paymentMethodTypes: paymentMethodTypes ?? ['card', 'link'],
  })

  // Resolve additional networks (best-effort)
  const additional = await resolveAdditionalNetworks(secretKey, isTestMode, parameters.additional)

  const methods = [tempoMethod, sptMethod, ...additional] as const
  const mppx = Mppx.create({ methods, secretKey: mppSecretKey, realm })

  // Record crypto payments as Stripe PaymentIntents via transaction verification
  mppx.onPaymentSuccess(({ receipt, request }) => {
    const amount = request?.amount
    if (receipt.reference && amount) {
      recordCryptoPayment({
        secretKey,
        method: receipt.method,
        reference: receipt.reference,
        amount: String(amount),
      })
    }
  })

  return mppx
}

export declare namespace stripe {
  type Parameters = {
    /** Stripe secret API key. */
    secretKey: string
    /** Stripe business network profile ID. */
    profileId: string
    /** Payment method types for SPT-based payments. @default ['card', 'link'] */
    paymentMethodTypes?: string[] | undefined
    /**
     * Additional crypto networks to enable beyond the defaults.
     * Entries with the same network name as a built-in override its config.
     */
    additional?: AdditionalNetworkEntry[] | undefined
    /** MPP secret key for challenge signing. Derived from Stripe key if not provided. */
    mppSecretKey?: string | undefined
    /** Server realm (e.g. hostname). Auto-detected if not set. */
    realm?: string | undefined
  }
}

export namespace stripe {
  /** Creates a Stripe SPT charge method for card/link payments. */
  export const spt = charge_

  /** @deprecated Use `stripe.spt()` instead. */
  export const charge = charge_
}

async function resolveAdditionalNetworks(
  secretKey: string,
  isTestMode: boolean,
  additional: AdditionalNetworkEntry[] | undefined,
): Promise<Method.AnyServer[]> {
  if (!additional || additional.length === 0) return []

  const methods: Method.AnyServer[] = []

  const resolved = await Promise.all(
    additional
      .filter((entry) => entry.network !== 'tempo')
      .map(async (entry) => ({
        entry,
        address: await resolveDepositAddress(secretKey, entry.network),
      })),
  )

  for (const { entry, address } of resolved) {
    if (!address) continue

    let methodOrMethods: Method.AnyServer | readonly Method.AnyServer[]

    if ('configure' in entry) {
      methodOrMethods = entry.configure(address)
    } else if (entry.network === 'base') {
      const { network: _, ...config } = entry
      methodOrMethods = evmCharge({
        currency: isTestMode ? EvmAssets.baseSepolia.USDC : EvmAssets.base.USDC,
        recipient: address as `0x${string}`,
        ...config,
      })
    } else {
      continue
    }

    if (Array.isArray(methodOrMethods)) {
      methods.push(...(methodOrMethods as readonly Method.AnyServer[]))
    } else {
      methods.push(methodOrMethods as Method.AnyServer)
    }
  }

  return methods
}

