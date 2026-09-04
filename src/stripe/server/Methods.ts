import * as EvmAssets from '../../evm/Assets.js'
import { charge as evmCharge } from '../../evm/server/Charge.js'
import type * as Method from '../../Method.js'
import * as tempoDefaults from '../../tempo/internal/defaults.js'
import { charge as tempoCharge } from '../../tempo/server/Charge.js'
import { session as tempoSession } from '../../tempo/session/server/Session.js'
import * as z from '../../zod.js'
import * as PaymentIntent from '../internal/payment-intent.js'
import type { StripeClient } from '../internal/types.js'
import { charge as charge_ } from './Charge.js'
import { buildAnalytics } from './internal/analytics.js'
import { findOrCreateDepositAddress as _findOrCreateDepositAddress } from './internal/deposit-address.js'
import * as HostedFeePayer from './internal/hosted-fee-payer.js'
import { recordCryptoPayment } from './internal/record-payment.js'
import { type ConnectConfig } from './internal/request.js'

// --- Public types ---

export declare namespace stripe {
  type Network = 'tempo' | 'base' | 'solana'

  type ResolvePaymentIntentOptionsContext = PaymentIntent.ResolveOptionsContext

  type DepositAddress<N extends Network = Network> = string & {
    readonly __brand: 'StripeDepositAddress'
    readonly __network: N
  }

  // TODO: make networkId and livemode also accept dynamic resolvers (fetched from
  // GET /v2/network/business_profiles/me which returns { id, livemode, ... }).
  // This would allow `stripe.create({ secretKey })` with no other params.
  type Parameters = {
    client: StripeClient
    networkId: string
    livemode: boolean
    hostedFeePayer?: boolean | undefined
    connect?: ConnectConfig
    depositAddresses?: Partial<Record<Network, string>> | ((network: Network) => Promise<string>)
    metadata?: Record<string, string> | undefined
  }
}

// --- Internal types ---

type CustomRailFactory = (address: string) => Method.AnyServer | readonly Method.AnyServer[]

type ServerOf<N extends string, I extends string> = Omit<Method.AnyServer, 'name' | 'intent'> & {
  name: N
  intent: I
}

type TempoServer = ServerOf<'tempo', 'charge'>
type TempoSessionServer = ServerOf<'tempo', 'session'>
type SptServer = ServerOf<'stripe', 'charge'>
type EvmServer = ServerOf<'evm', 'charge'>

type BaseConfig = {
  x402: NonNullable<Parameters<typeof evmCharge>[0]['x402']>
} & Partial<Omit<Parameters<typeof evmCharge>[0], 'currency' | 'recipient' | 'x402'>>

type CustomRailNetwork = Exclude<stripe.Network, 'tempo' | 'base'>

type AdditionalConfig = {
  base?: BaseConfig
  tempo?: { session: Omit<tempoSession.Parameters, 'currency' | 'recipient'> }
} & { [K in CustomRailNetwork]?: CustomRailFactory }

type DefaultMethods = readonly [TempoServer, SptServer]

type DefaultMethodsWithAdditional<C extends AdditionalConfig> = readonly [
  TempoServer,
  SptServer,
  ...(C extends { base: object } ? [EvmServer] : []),
  ...(C extends { tempo: { session: any } } ? [TempoSessionServer] : []),
]

type DefaultMethodName = 'tempo' | 'spt'
const defaultMethodNames: readonly DefaultMethodName[] = ['tempo', 'spt']

type AdditionalBuiltinKey = 'base' | 'tempo'
const additionalBuiltinKeys: readonly AdditionalBuiltinKey[] = ['base', 'tempo']

type DefaultMethodsConfig = {
  exclude?: DefaultMethodName[]
}

type SyncMethodsResult = DefaultMethods & {
  additional<C extends AdditionalConfig>(config: C): DefaultMethodsWithAdditional<C>
}

interface StripeMachinePayments<P extends stripe.Parameters = stripe.Parameters> {
  spt: {
    charge: (params?: { paymentMethodTypes?: string[] }) => SptServer
  }
  tempo: {
    charge: (
      params: {
        recipient: stripe.DepositAddress<'tempo'>
        metadata?: Record<string, string>
      } & Partial<Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>>,
    ) => TempoServer
    session: (
      params: { recipient: stripe.DepositAddress<'tempo'> } & Omit<
        tempoSession.Parameters,
        'currency' | 'recipient'
      >,
    ) => TempoSessionServer
  }
  base: {
    charge: (
      params: {
        recipient: stripe.DepositAddress<'base'>
        metadata?: Record<string, string>
      } & BaseConfig,
    ) => EvmServer
  }
  findOrCreateDepositAddress: <N extends stripe.Network>(
    network: N,
  ) => Promise<stripe.DepositAddress<N>>
  defaultMethods: (
    config?: DefaultMethodsConfig,
  ) => P['depositAddresses'] extends (network: stripe.Network) => Promise<string>
    ? DefaultMethodsBuilder
    : SyncMethodsResult
}

class DefaultMethodsBuilder implements PromiseLike<DefaultMethods> {
  readonly #resolve: (additional?: AdditionalConfig) => Promise<any>
  #additional: AdditionalConfig | undefined

  constructor(resolve: (additional?: AdditionalConfig) => Promise<any>) {
    this.#resolve = resolve
  }

  additional<C extends AdditionalConfig>(config: C): PromiseLike<DefaultMethodsWithAdditional<C>> {
    this.#additional = config
    return this as unknown as PromiseLike<DefaultMethodsWithAdditional<C>>
  }

  then<T = DefaultMethods, U = never>(
    onfulfilled?: ((value: DefaultMethods) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): Promise<T | U> {
    return this.#resolve(this.#additional).then(onfulfilled, onrejected)
  }
}

/**
 * Creates a configured Stripe machine payments instance.
 *
 * @example
 * ```ts
 * import { Mppx, stripe } from 'mppx/server'
 *
 * const machinePayments = stripe.create({
 *   client: stripeClient,
 *   networkId: process.env.STRIPE_PROFILE_ID!,
 *   livemode: !process.env.STRIPE_SECRET_KEY!.includes('_test_'),
 * })
 *
 * // Async: deposit addresses resolved from Stripe API
 * const mppx = Mppx.create({
 *   methods: await machinePayments.defaultMethods(),
 *   secretKey: mppSecretKey,
 * })
 * ```
 *
 * @example
 * ```ts
 * // Sync: deposit addresses provided statically
 * const machinePayments = stripe.create({
 *   client: stripeClient,
 *   networkId: process.env.STRIPE_PROFILE_ID!,
 *   livemode: !process.env.STRIPE_SECRET_KEY!.includes('_test_'),
 *   depositAddresses: { tempo: process.env.TEMPO_DEPOSIT_ADDRESS! },
 * })
 *
 * const mppx = Mppx.create({
 *   methods: machinePayments.defaultMethods(),
 *   secretKey: mppSecretKey,
 * })
 * ```
 *
 * @example
 * ```ts
 * // With additional custom rails
 * const mppx = Mppx.create({
 *   methods: await machinePayments.defaultMethods().additional({
 *     base: { x402: { facilitator } },
 *     solana: (address) => solana.charge({ recipient: address, currency: USDC, decimals: 6 }),
 *   }),
 *   secretKey: mppSecretKey,
 * })
 * ```
 *
 * PaymentIntent option resolvers run after non-mutating method validation, when
 * available, and before the terminal payment operation. If Stripe later rejects
 * resolved optional fields while recording a completed crypto payment, mppx
 * retries the recording once without them. SPT payments do not use this fallback.
 */
export function stripe<const P extends stripe.Parameters>(parameters: P): StripeMachinePayments<P> {
  const { client, networkId, livemode, hostedFeePayer, connect, depositAddresses, metadata } =
    parameters
  if (!client.rawRequest)
    throw new Error('stripe.create() requires a Stripe SDK client with rawRequest() (v15+)')
  if (hostedFeePayer && !livemode)
    throw new Error('Stripe hosted fee payer requires a live-mode integration.')
  if (hostedFeePayer && connect)
    throw new Error('Stripe hosted fee payer does not support Connect account routing.')
  const tempoCurrency = (
    livemode ? tempoDefaults.tokens.usdc : tempoDefaults.tokens.pathUsd
  ) as `0x${string}`
  const hostedTempoFeePayer = hostedFeePayer ? HostedFeePayer.create(client) : undefined
  const tempoPaymentHandler = createPaymentSuccessHandler(client, 'tempo', connect, metadata)
  const basePaymentHandler = createPaymentSuccessHandler(client, 'base', connect, metadata)

  // All stripe-managed crypto rails use 6-decimal stablecoins. Reject amounts
  // below 1 cent since Stripe cannot record them.
  const cryptoCanOffer = ({ request }: { request: { amount: string } }) =>
    Number(request.amount) >= 10_000

  function makeSptCharge(params?: { paymentMethodTypes?: string[] }): Method.AnyServer {
    return charge_({
      client,
      networkId,
      currency: 'usd',
      decimals: 2,
      paymentMethodTypes: params?.paymentMethodTypes ?? ['card', 'link'],
      ...(connect && { connect }),
      ...(metadata && { metadata }),
    } as Parameters<typeof charge_>[0]) as Method.AnyServer
  }

  function makeTempoCharge(
    params: { recipient: `0x${string}`; metadata?: Record<string, string> } & Partial<
      Omit<Parameters<typeof tempoCharge>[0], 'currency' | 'recipient'>
    >,
  ): Method.AnyServer {
    const { recipient, metadata: callMetadata, ...rest } = params
    const handler = callMetadata
      ? createPaymentSuccessHandler(client, 'tempo', connect, { ...metadata, ...callMetadata })
      : tempoPaymentHandler
    return withPaymentIntentInput(
      tempoCharge({
        currency: tempoCurrency,
        recipient,
        ...(!livemode && { testnet: true }),
        ...(hostedTempoFeePayer && { feePayer: hostedTempoFeePayer }),
        canOffer: cryptoCanOffer,
        onPaymentSuccess: handler,
        ...rest,
      }) as Method.AnyServer,
    )
  }

  function makeTempoSession(
    params: { recipient: `0x${string}` } & Omit<tempoSession.Parameters, 'currency' | 'recipient'>,
  ): Method.AnyServer {
    const { recipient, ...rest } = params
    return tempoSession({
      currency: tempoCurrency,
      recipient,
      ...(!livemode && { testnet: true }),
      ...(hostedTempoFeePayer && { feePayer: hostedTempoFeePayer }),
      ...rest,
    } as tempoSession.Parameters) as Method.AnyServer
  }

  function makeBaseCharge(
    params: { recipient: `0x${string}`; metadata?: Record<string, string> } & BaseConfig,
  ): Method.AnyServer {
    const { recipient, x402, metadata: callMetadata, ...rest } = params
    const handler = callMetadata
      ? createPaymentSuccessHandler(client, 'base', connect, { ...metadata, ...callMetadata })
      : basePaymentHandler
    return withPaymentIntentInput(
      evmCharge({
        currency: livemode ? EvmAssets.base.USDC : EvmAssets.baseSepolia.USDC,
        recipient,
        x402,
        canOffer: cryptoCanOffer,
        onPaymentSuccess: handler,
        ...rest,
      }) as Method.AnyServer,
    )
  }

  const defaultMethodBuilders: Record<
    DefaultMethodName,
    (addresses: Map<string, string>) => Method.AnyServer | null
  > = {
    tempo: (addresses) => {
      const address = addresses.get('tempo')
      if (!address) return null
      return makeTempoCharge({ recipient: address as `0x${string}` })
    },
    spt: () => makeSptCharge(),
  }

  const additionalBuilders: Record<
    AdditionalBuiltinKey,
    (addresses: Map<string, string>, config: AdditionalConfig) => Method.AnyServer | null
  > = {
    base: (addresses, config) => {
      if (!config.base) return null
      const address = addresses.get('base')
      if (!address) return null
      return makeBaseCharge({ recipient: address as `0x${string}`, ...config.base })
    },
    tempo: (addresses, config) => {
      if (!config.tempo?.session) return null
      const address = addresses.get('tempo')
      if (!address) return null
      return makeTempoSession({ recipient: address as `0x${string}`, ...config.tempo.session })
    },
  }

  function createMethodsFromAddresses(
    addresses: Map<string, string>,
    excluded: Set<string>,
    additional?: AdditionalConfig,
  ): DefaultMethods {
    const result: Method.AnyServer[] = []

    for (const name of defaultMethodNames) {
      if (excluded.has(name)) continue
      const method = defaultMethodBuilders[name](addresses)
      if (method) result.push(method)
    }

    if (additional) {
      for (const key of Object.keys(additionalBuilders) as AdditionalBuiltinKey[]) {
        const method = additionalBuilders[key](addresses, additional)
        if (method) result.push(method)
      }

      for (const [network, factory] of customRails(additional)) {
        const address = requireAddress(addresses, network)
        const recorder = createPaymentSuccessHandler(
          client,
          network as stripe.Network,
          connect,
          metadata,
        )
        for (const m of toArray(factory(address))) {
          const onPaymentSuccess = m.onPaymentSuccess
            ? (params: any) =>
                Promise.all([m.onPaymentSuccess!(params), recorder(params)]).then(() => {})
            : recorder
          const canOffer = m.canOffer
            ? (params: any) => cryptoCanOffer(params) && m.canOffer!(params)
            : cryptoCanOffer
          result.push(
            withPaymentIntentInput({ ...m, canOffer, onPaymentSuccess } as Method.AnyServer),
          )
        }
      }
    }

    return result as unknown as DefaultMethods
  }

  function resolveAddress(network: string): Promise<string> {
    if (typeof depositAddresses === 'function') return depositAddresses(network as stripe.Network)
    return _findOrCreateDepositAddress(client, network, connect ? { connect } : undefined)
  }

  function defaultMethods(
    config?: DefaultMethodsConfig,
  ): SyncMethodsResult | DefaultMethodsBuilder {
    const excluded = new Set(config?.exclude)

    if (typeof depositAddresses === 'function') {
      // Async: resolve addresses dynamically
      return new DefaultMethodsBuilder(async (additional) => {
        const networks = neededNetworks(excluded, additional)
        const results = await Promise.allSettled(
          networks.map(async (network) => ({
            network,
            address: await resolveAddress(network),
          })),
        )
        const addresses = new Map<string, string>()
        for (const result of results) {
          if (result.status === 'fulfilled') {
            addresses.set(result.value.network, result.value.address)
          } else {
            const idx = results.indexOf(result)
            console.warn(
              `[stripe.create] ${networks[idx]} method excluded: ${(result.reason as Error)?.message ?? result.reason}`,
            )
          }
        }
        return createMethodsFromAddresses(addresses, excluded, additional)
      })
    }

    const addresses = new Map(Object.entries(depositAddresses ?? {})) as Map<string, string>

    return Object.assign(createMethodsFromAddresses(addresses, excluded), {
      additional: (additional: AdditionalConfig) =>
        createMethodsFromAddresses(addresses, excluded, additional),
    }) as SyncMethodsResult
  }

  return {
    spt: { charge: makeSptCharge },
    tempo: { charge: makeTempoCharge, session: makeTempoSession },
    base: { charge: makeBaseCharge },
    findOrCreateDepositAddress: async <N extends stripe.Network>(network: N) => {
      const address = await resolveAddress(network)
      return address as stripe.DepositAddress<N>
    },
    defaultMethods,
  } as StripeMachinePayments
}

export namespace stripe {
  export const spt = charge_

  /** @deprecated Use `stripe.create({ ... }).spt.charge()` or `stripe.spt()` instead. */
  export const charge = charge_

  export const create = stripe

  export const findOrCreateDepositAddress = _findOrCreateDepositAddress
}

function neededNetworks(excluded: Set<string>, additional?: AdditionalConfig): stripe.Network[] {
  const networks: stripe.Network[] = []
  if (!excluded.has('tempo') || additional?.tempo?.session) networks.push('tempo')
  if (additional?.base) networks.push('base')
  for (const [network] of customRails(additional)) {
    networks.push(network as stripe.Network)
  }
  return networks
}

function requireAddress(addresses: Map<string, string>, network: string): string {
  const address = addresses.get(network)
  if (!address) throw new Error(`stripe: missing deposit address for ${network}`)
  return address
}

function toArray(
  value: Method.AnyServer | readonly Method.AnyServer[],
): readonly Method.AnyServer[] {
  return Array.isArray(value) ? value : [value]
}

function customRails(additional?: AdditionalConfig): [string, CustomRailFactory][] {
  if (!additional) return []
  return Object.entries(additional).filter((entry): entry is [string, CustomRailFactory] => {
    const [k, v] = entry
    return !(additionalBuiltinKeys as readonly string[]).includes(k) && typeof v === 'function'
  })
}

function createPaymentSuccessHandler(
  client: StripeClient,
  network: stripe.Network,
  connect?: ConnectConfig,
  metadata?: Record<string, string>,
) {
  return (params: { challenge?: any; receipt: any; request: any; requestInput?: any }) => {
    const { challenge, receipt, request, requestInput } = params
    if (receipt?.reference && request?.amount) {
      const paymentIntentOptionsInput = requestInput?.paymentIntentOptions as
        | PaymentIntent.OptionsInput
        | undefined
      const paymentIntentOptions =
        typeof paymentIntentOptionsInput === 'function' ? undefined : paymentIntentOptionsInput
      const resolvedMetadata = {
        ...metadata,
        ...paymentIntentOptions?.metadata,
      }
      const resolvedPaymentIntentOptions = {
        ...paymentIntentOptions,
        ...(Object.keys(resolvedMetadata).length > 0 && { metadata: resolvedMetadata }),
      }
      return recordCryptoPayment(client, {
        network,
        reference: receipt.reference,
        amount: String(request.amount),
        ...(connect && { connect }),
        analyticsMetadata: buildAnalytics({ challenge }),
        ...(Object.keys(resolvedPaymentIntentOptions).length > 0 && {
          paymentIntentOptions: resolvedPaymentIntentOptions,
        }),
      })
    }
  }
}

/**
 * Extends a rail's server-only input with Stripe PaymentIntent options while
 * keeping its canonical request unchanged. The schema strips the options
 * before challenge serialization, and delegated lifecycle hooks receive the
 * underlying rail request without Stripe-only fields. After method validation,
 * the wrapper resolves the options immediately before the terminal operation
 * and retains the result in `requestInput` for payment-success recording.
 */
function withPaymentIntentInput(method: Method.AnyServer): Method.AnyServer {
  const baseSchema = method.schema.request
  const baseRequest = method.request
  const baseRespond = method.respond
  const baseBroadcast = method.broadcast
  const baseValidate = method.validate
  const baseVerify = method.verify

  return {
    ...method,
    // Accept Stripe-only options without changing the canonical rail schema.
    schema: {
      ...method.schema,
      request: z.pipe(
        z.custom<
          z.input<typeof baseSchema> & {
            paymentIntentOptions?: PaymentIntent.OptionsInput | undefined
          }
        >(),
        z.transform((input) => {
          const { paymentIntentOptions, ...request } = input
          z.optional(PaymentIntent.InputSchema).parse(paymentIntentOptions)
          // Only the base schema's output is included in the challenge.
          return baseSchema.parse(request)
        }),
      ),
    },
    async request(context: Method.RequestContext<Method.AnyServer>) {
      const { paymentIntentOptions, ...request } = context.request
      const resolved = baseRequest ? await baseRequest({ ...context, request }) : request
      // Keep the server-only value in requestInput for the success hook. The
      // schema transform above still excludes it from the signed challenge.
      return { ...resolved, paymentIntentOptions }
    },
    ...(baseRespond && {
      respond: (context: Method.RespondContext<Method.AnyServer>) =>
        baseRespond(withoutPaymentIntentOptions(context)),
    }),
    ...(baseBroadcast && {
      async broadcast(context: Method.VerifyContext<Method.AnyServer>) {
        await resolvePaymentIntentOptions(context)
        return baseBroadcast(withoutPaymentIntentOptions(context))
      },
    }),
    ...(baseValidate && {
      validate: (context: Method.ValidateContext<Method.AnyServer>) =>
        baseValidate(withoutPaymentIntentOptions(context)),
    }),
    ...(baseVerify && {
      async verify(context: Method.VerifyContext<Method.AnyServer>) {
        await resolvePaymentIntentOptions(context)
        return baseVerify(withoutPaymentIntentOptions(context))
      },
    }),
  }
}

/** Resolves Stripe-only options immediately before the terminal payment operation. */
async function resolvePaymentIntentOptions(
  context: Method.VerifyContext<Method.AnyServer>,
): Promise<void> {
  const { paymentIntentOptions } = context.request
  const resolved = await PaymentIntent.resolve(paymentIntentOptions, {
    challenge: context.credential.challenge,
    credential: context.credential,
    envelope: context.envelope,
    request: context.envelope?.request ?? context.credential.challenge.request,
  })
  // MPPX later snapshots this request-local input for onPaymentSuccess. Replacing
  // only the schema-stripped field keeps the canonical challenge unchanged.
  context.request.paymentIntentOptions = resolved
}

function withoutPaymentIntentOptions<context extends { request: Record<string, unknown> }>(
  context: context,
): context {
  const { paymentIntentOptions: _, ...request } = context.request
  return { ...context, request }
}
