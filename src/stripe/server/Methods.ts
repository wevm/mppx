import type * as Method from '../../Method.js'
import type * as Receipt from '../../Receipt.js'
import * as tempoDefaults from '../../tempo/internal/defaults.js'
import { charge as tempoCharge } from '../../tempo/server/Charge.js'
import { session as tempoSession } from '../../tempo/session/server/Session.js'
import { charge as evmCharge } from '../../evm/server/Charge.js'
import * as EvmAssets from '../../evm/Assets.js'
import { charge as charge_ } from './Charge.js'
import { resolveDepositAddress } from './internal/deposit-address.js'
import { recordCryptoPayment } from './internal/record-payment.js'

type StripeClient = {
  paymentIntents: { create: (...args: any[]) => any }
}

type CustomRailFactory = (address: string) => Method.AnyServer | readonly Method.AnyServer[]

type TempoServer = Method.AnyServer & { name: 'tempo'; intent: 'charge' }
type TempoSessionServer = Method.AnyServer & { name: 'tempo'; intent: 'session' }
type SptServer = Method.AnyServer & { name: 'stripe'; intent: 'charge' }
type EvmServer = Method.AnyServer & { name: 'evm'; intent: 'charge' }

type MethodsResult<C extends MethodsConfig> = readonly [
  ...(C extends { spt: object } ? [SptServer] : []),
  ...(C extends { tempo: { charge: any } } ? [TempoServer] : []),
  ...(C extends { tempo: { session: any } } ? [TempoSessionServer] : []),
  ...(C extends { base: object } ? [EvmServer] : []),
  ...Method.AnyServer[],
]

type DefaultMethodsConfig = {
  base?: BaseConfig
  additional?: Record<string, CustomRailFactory>
}

type DefaultMethodsResult<C extends DefaultMethodsConfig> = readonly [
  TempoServer,
  SptServer,
  ...(C extends { base: object } ? [EvmServer] : []),
  ...Method.AnyServer[],
]

interface StripeMachinePayments {
  spt: {
    charge: typeof charge_
  }
  tempo: {
    charge: (params?: Partial<Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>>) => TempoServer
    session: (params: Omit<Parameters<typeof tempoSession>[0], 'currency' | 'recipient'>) => TempoSessionServer
  }
  base: {
    charge: (params: BaseConfig) => EvmServer
  }
  methods: <C extends MethodsConfig>(config: C) => MethodsResult<C>
  /**
   * Returns all default payment methods (tempo charge + SPT) plus any additional custom rails.
   * Use this when you want maximum coverage with minimal config.
   */
  defaultMethods: <C extends DefaultMethodsConfig>(config?: C) => DefaultMethodsResult<C>
}

type BaseConfig = {
  x402: Omit<NonNullable<Parameters<typeof evmCharge>[0]['x402']>, never>
} & Partial<Omit<Parameters<typeof evmCharge>[0], 'currency' | 'recipient' | 'x402'>>

type MethodsConfig = {
  spt?: { charge?: boolean | Omit<Parameters<typeof charge_>[0], 'secretKey' | 'networkId'> }
  tempo?: {
    currency?: `0x${string}`
    charge?: boolean | Partial<Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>>
    session?: Omit<Parameters<typeof tempoSession>[0], 'currency' | 'recipient'>
  }
  base?: BaseConfig
} & {
  [network: string]: CustomRailFactory | undefined | { charge?: any; session?: any; currency?: any; x402?: any }
}

/**
 * Creates a configured Stripe machine payments instance.
 *
 * Resolves deposit addresses eagerly so all subsequent method calls are synchronous.
 * Methods returned from this instance automatically record crypto payments as
 * Stripe PaymentIntents via transaction verification.
 *
 * @example
 * ```ts
 * import { Mppx, stripe } from 'mppx/server'
 * import { solana } from '@solana/mpp/server'
 *
 * const machinePayments = await stripe.create({
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   networkId: process.env.STRIPE_PROFILE_ID!,
 * })
 *
 * // Option 1: Auto-enable defaults (tempo + SPT) with additional custom rails
 * const mppx = Mppx.create({
 *   methods: machinePayments.defaultMethods({
 *     additional: {
 *       solana: (address) => solana.charge({ recipient: address, currency: USDC, decimals: 6 }),
 *     },
 *   }),
 *   secretKey: mppSecretKey,
 * })
 * ```
 *
 * @example
 * ```ts
 * // Option 2: Declare exactly which methods you want
 * const mppx = Mppx.create({
 *   methods: machinePayments.methods({
 *     spt: { charge: true },
 *     tempo: { charge: true },
 *     base: { x402: { facilitator } },
 *     solana: (address) => solana.charge({ recipient: address, currency: USDC, decimals: 6 }),
 *   }),
 *   secretKey: mppSecretKey,
 * })
 * ```
 *
 * @example
 * ```ts
 * // Option 3: Use individual method factories for full control
 * const mppx = Mppx.create({
 *   methods: [
 *     machinePayments.spt.charge({ secretKey, networkId, paymentMethodTypes: ['card', 'link'] }),
 *     machinePayments.tempo.charge(),
 *     machinePayments.base.charge({ x402: { facilitator } }),
 *     solana.charge({ recipient: solanaAddress, currency: USDC, decimals: 6, network: 'mainnet-beta' }),
 *   ],
 *   secretKey: mppSecretKey,
 * })
 * ```
 */
export async function stripe<const parameters extends stripe.Parameters>(
  parameters: parameters,
): Promise<StripeMachinePayments> {
  const { secretKey, networkId } = parameters
  const isTestMode = secretKey.includes('_test_')

  // Eagerly resolve all deposit addresses
  const addresses = await resolveAllDepositAddresses(secretKey)

  const tempoAddress = addresses.get('tempo') ?? null
  const baseAddress = addresses.get('base') ?? null

  function makeTempoCharge(
    params?: Partial<Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>>,
  ): Method.AnyServer {
    if (!tempoAddress) {
      throw new Error('stripe: no Tempo deposit address available. Ensure crypto is enabled on your Stripe account.')
    }
    const method = tempoCharge({
      currency: (isTestMode
        ? tempoDefaults.tokens.pathUsd
        : tempoDefaults.tokens.usdc) as `0x${string}`,
      recipient: tempoAddress as `0x${string}`,
      ...(isTestMode && { testnet: true }),
      ...params,
    })
    return withPaymentRecording(method, secretKey)
  }

  function makeTempoSession(
    params: Omit<Parameters<typeof tempoSession>[0], 'currency' | 'recipient'>,
  ): Method.AnyServer {
    if (!tempoAddress) {
      throw new Error('stripe: no Tempo deposit address available. Ensure crypto is enabled on your Stripe account.')
    }
    const method = tempoSession({
      currency: (isTestMode
        ? tempoDefaults.tokens.pathUsd
        : tempoDefaults.tokens.usdc) as `0x${string}`,
      recipient: tempoAddress as `0x${string}`,
      ...(isTestMode && { testnet: true }),
      ...params,
    } as Parameters<typeof tempoSession>[0])
    return withPaymentRecording(method as Method.AnyServer, secretKey)
  }

  function makeBaseCharge(params: BaseConfig): Method.AnyServer {
    if (!baseAddress) {
      throw new Error('stripe: no Base deposit address available. Ensure crypto is enabled on your Stripe account.')
    }
    const { x402, ...rest } = params
    const method = evmCharge({
      currency: isTestMode ? EvmAssets.baseSepolia.USDC : EvmAssets.base.USDC,
      recipient: baseAddress as `0x${string}`,
      x402,
      ...rest,
    })
    return withPaymentRecording(method as Method.AnyServer, secretKey)
  }

  function makeSptCharge(params: Parameters<typeof charge_>[0]): Method.AnyServer {
    return charge_(params) as Method.AnyServer
  }

  function methods<C extends MethodsConfig>(config: C): MethodsResult<C> {
    const result: Method.AnyServer[] = []

    // SPT
    if (config.spt?.charge) {
      const sptConfig = config.spt.charge === true ? {} : config.spt.charge
      result.push(makeSptCharge({
        secretKey: secretKey,
        networkId: networkId!,
        paymentMethodTypes: ['card', 'link'],
        ...sptConfig,
      } as Parameters<typeof charge_>[0]))
    }

    // Tempo
    if (config.tempo) {
      const tempoCurrency = config.tempo.currency ?? (isTestMode
        ? tempoDefaults.tokens.pathUsd
        : tempoDefaults.tokens.usdc) as `0x${string}`

      if (config.tempo.charge) {
        const chargeConfig = config.tempo.charge === true ? {} : config.tempo.charge
        result.push(makeTempoCharge({ ...chargeConfig }))
      }
      if (config.tempo.session) {
        result.push(makeTempoSession(config.tempo.session))
      }
    }

    // Base (EVM)
    if (config.base) {
      const address = addresses.get('base')
      if (address) {
        const { x402, ...baseRest } = config.base
        const method = evmCharge({
          currency: isTestMode ? EvmAssets.baseSepolia.USDC : EvmAssets.base.USDC,
          recipient: address as `0x${string}`,
          x402,
          ...baseRest,
        })
        result.push(withPaymentRecording(method as Method.AnyServer, secretKey))
      }
    }

    // Custom rails
    for (const [network, value] of Object.entries(config)) {
      if (network === 'spt' || network === 'tempo' || network === 'base') continue
      if (typeof value !== 'function') continue

      const address = addresses.get(network)
      if (!address) continue

      const methodOrMethods = value(address)
      const methods = Array.isArray(methodOrMethods)
        ? (methodOrMethods as readonly Method.AnyServer[])
        : [methodOrMethods as Method.AnyServer]

      for (const m of methods) {
        result.push(withPaymentRecording(m, secretKey))
      }
    }

    return result as unknown as MethodsResult<C>
  }

  function defaultMethods<C extends DefaultMethodsConfig>(config?: C): DefaultMethodsResult<C> {
    const result: Method.AnyServer[] = [
      makeTempoCharge(),
      makeSptCharge({
        secretKey: secretKey,
        networkId: networkId!,
        paymentMethodTypes: ['card', 'link'],
      } as Parameters<typeof charge_>[0]),
    ]

    if (config?.base) {
      result.push(makeBaseCharge(config.base))
    }

    if (config?.additional) {
      for (const [network, factory] of Object.entries(config.additional)) {
        const address = addresses.get(network)
        if (!address) continue

        const methodOrMethods = factory(address)
        const methods = Array.isArray(methodOrMethods)
          ? (methodOrMethods as readonly Method.AnyServer[])
          : [methodOrMethods as Method.AnyServer]

        for (const m of methods) {
          result.push(withPaymentRecording(m, secretKey))
        }
      }
    }

    return result as unknown as DefaultMethodsResult<C>
  }

  return {
    spt: { charge: charge_ },
    tempo: {
      charge: makeTempoCharge,
      session: makeTempoSession,
    },
    base: {
      charge: makeBaseCharge,
    },
    methods,
    defaultMethods,
  }
}

export declare namespace stripe {
  type Parameters = {
    /** Pre-configured Stripe SDK client. */
    client?: StripeClient | undefined
    /** Stripe secret API key. */
    secretKey: string
    /** Stripe business network profile ID (used by .methods() and .defaultMethods()). */
    networkId: string
  }
}

export namespace stripe {
  /** Creates a Stripe SPT charge method for card/link payments. */
  export const spt = charge_

  /** @deprecated Use `stripe.spt()` or `stripe.create()` instead. */
  export const charge = charge_

  export const create = stripe
}

/**
 * Resolves all deposit addresses for the account.
 */
async function resolveAllDepositAddresses(
  secretKey: string,
): Promise<Map<string, string>> {
  const networks = ['tempo', 'base', 'solana']
  const results = await Promise.all(
    networks.map(async (network) => ({
      network,
      address: await resolveDepositAddress(secretKey, network),
    })),
  )

  const map = new Map<string, string>()
  for (const { network, address } of results) {
    if (address) map.set(network, address)
  }
  return map
}

/**
 * Adds a respond hook to record crypto payments as Stripe PaymentIntents.
 * The respond hook fires after verify succeeds and has access to both
 * the receipt (tx hash) and the request (amount in atomic units).
 */
function withPaymentRecording(
  method: Method.AnyServer,
  secretKey: string,
): Method.AnyServer {
  const originalRespond = method.respond
  const wrapped = {
    ...method,
    async respond(params: any) {
      const { receipt, request } = params
      if (receipt?.reference && request?.amount) {
        recordCryptoPayment({
          secretKey,
          method: receipt.method,
          reference: receipt.reference,
          amount: String(request.amount),
        })
      }
      return originalRespond?.(params)
    },
  }
  return wrapped
}
