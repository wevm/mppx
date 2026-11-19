import { getAddress, recoverTypedDataAddress } from 'viem'

import type * as Credential from '../../Credential.js'
import * as Currency from '../../Currency.js'
import * as Errors from '../../Errors.js'
import { VerificationFailedError } from '../../Errors.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as ServerTransport from '../../server/Transport.js'
import type * as Store from '../../Store.js'
import * as X402 from '../../x402/server/EvmCharge.js'
import * as X402Facilitator from '../../x402/server/Facilitator.js'
import * as Siwx from '../../x402/Siwx.js'
import type * as z from '../../zod.js'
import * as Assets from '../Assets.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates an EVM charge server method.
 *
 * Speaks the native Payment-auth `evm/charge` wire format.
 * Supports non-mutating `validateCredential` checks before settlement through
 * `broadcastCredential`. Validation checks the signature and payment terms, and
 * checks the facilitator when using facilitator-backed settlement. Custom
 * settlers remain responsible for chain-state checks and replay protection.
 */
export function charge(
  parameters: charge.NativeConfig,
): Method.Server<typeof Methods.charge, charge.Defaults, ServerTransport.Http>
export function charge(parameters: charge.NativeConfig): Method.AnyServer {
  const config = resolveConfig(parameters)
  const paths = createPaths(config)
  const transport = httpTransport(paths)

  const server = Method.toServer<typeof Methods.charge, charge.Defaults, typeof transport>(
    Methods.charge,
    {
      ...(config.x402.siwx ? { authorize: siwxAuthorize(config.x402.siwx) } : {}),
      canOffer: parameters.canOffer,
      onPaymentSuccess: parameters.onPaymentSuccess,
      defaults: {
        chainId: config.chainId,
        currency: config.currency,
        credentialTypes: ['authorization'],
        decimals: config.decimals,
        // A resolved recipient is filled in per challenge by the request hook below.
        ...(typeof config.recipient === 'string' ? { recipient: config.recipient } : {}),
      } as charge.Defaults,
      ...(typeof config.recipient === 'function'
        ? {
            request: recipientHook(config.recipient),
            stableBinding: chargeBinding(config.recipient),
          }
        : {}),
      transport,
      async validate({ credential }) {
        const payload = credential.payload as Types.AuthorizationPayload
        const request = credential.challenge.request as Types.ChargeRequest
        const chainId = request.methodDetails.chainId
        const isX402Credential = X402.isCredential(credential)

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

        const authorization = {
          credential,
          payload,
          request,
          source,
        }
        await config.validate?.(authorization)

        const payer = getAddress(payload.from)
        return {
          challenge: credential.challenge,
          credential,
          details: { payer },
          intent: Methods.charge.intent,
          method: Methods.charge.name,
          payer,
          request: credential.challenge.request,
          source,
        }
      },
      async broadcast({ credential }) {
        const payload = credential.payload as Types.AuthorizationPayload
        const request = credential.challenge.request as Types.ChargeRequest
        const settled = await config.settle({
          credential,
          payload,
          request,
          source: Types.toSource({
            address: getAddress(payload.from),
            chainId: request.methodDetails.chainId,
          }),
        })

        const extensions = toJsonExtensions(settled.extensions)
        return Receipt.from({
          ...(extensions ? { extensions } : {}),
          method: Types.paymentMethod,
          reference: settled.reference,
          status: 'success',
          timestamp: settled.timestamp ?? new Date().toISOString(),
        })
      },
    },
  )
  // A route whose request is resolved from the credential answers a rejected credential with the
  // Challenge a fresh request gets, so a replaced recipient is never re-signed.
  if (typeof config.recipient === 'function')
    Object.defineProperty(server, '_freshRetryChallenge', { value: true })
  return server
}

export declare namespace charge {
  type Parameters = NativeConfig
  type Native = Method.Server<typeof Methods.charge, Defaults, ServerTransport.Http>

  type NativeConfig = BaseConfig &
    CurrencyConfig &
    RecipientConfig &
    Method.ComposableHooks<typeof Methods.charge>

  type BaseConfig = {
    /** EIP-3009 token domain metadata. Required for raw addresses and viem tokens; inferred for known assets. */
    authorization?: Types.AuthorizationConfig | undefined
    /** EVM chain ID. Required for raw addresses and viem tokens; inferred for known assets. */
    chainId?: number | undefined
    /** Token decimal places. Required for raw addresses; inferred for known assets and viem tokens. */
    decimals?: number | undefined
    /** Custom settlement override. If omitted, `x402.facilitator` is used. */
    settle?: SettleAuthorization | undefined
    /** x402 compatibility options. */
    x402?: X402.Options | undefined
  }

  type CurrencyConfig = {
    /** Token contract address, known EVM asset metadata, or viem token definition. */
    currency: Assets.Currency
  }

  type RecipientConfig = {
    /**
     * Recipient wallet address, or a function that returns it, called for each challenge.
     *
     * A payment naming an address the function returned less than 10 minutes ago still verifies,
     * so in-flight payments survive a change. Pass `evm.facilitatorPayToResolver()` (or any
     * `createPayToResolver()`) to cache reads or change that window.
     *
     * Leave it out when `x402.facilitator` settles into an address of its own and publishes it as
     * `payTo` in `GET /supported` (such as the Tempo x402 facilitator): the address is read on the
     * first challenge, cached and refreshed every 5 minutes.
     */
    recipient?: `0x${string}` | (() => `0x${string}` | Promise<`0x${string}`>) | undefined
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
    /**
     * Settlement data to pass through on the Receipt and the x402 `PAYMENT-RESPONSE`, such as
     * an x402 facilitator's `SettleResponse.extensions`.
     */
    extensions?: Record<string, unknown> | undefined
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
  recipient: `0x${string}` | X402Facilitator.PayToResolver
  settle: charge.SettleAuthorization
  validate?: ((parameters: Parameters<charge.SettleAuthorization>[0]) => Promise<void>) | undefined
  x402: X402.ResolvedOptions
}

type HttpPath = {
  credentialHeaders: readonly string[]
  bindCredential: NonNullable<ServerTransport.Http['bindCredential']>
  captureRequest?: ServerTransport.Http['captureRequest'] | undefined
  getCredential: ServerTransport.Http['getCredential']
  matchCredential?: ServerTransport.Http['matchCredential'] | undefined
  respondChallenge: (
    options: Parameters<ServerTransport.Http['respondChallenge']>[0],
    response?: Response | undefined,
  ) => Response | Promise<Response>
  respondReceipt: (
    options: Parameters<ServerTransport.Http['respondReceipt']>[0],
    response: Response,
  ) => Response
}

type HttpPaths = {
  mpp: HttpPath
  x402: HttpPath
}

function resolveConfig(config: charge.NativeConfig): ResolvedConfig {
  const { currency, recipient } = config
  let address: `0x${string}`
  let authorization = config.authorization
  let chainId = config.chainId
  let decimals = config.decimals

  chainId ??= Currency.chainIdOf(currency)

  if (chainId !== undefined) {
    const resolved = Assets.resolve(currency, Types.networkOf(chainId))
    if (!resolved) throw new Error(`EVM currency is not available on chain ID ${chainId}.`)
    address = resolved.address
    decimals ??= resolved.decimals
    if (resolved.transfer?.type === Types.eip3009) {
      authorization ??= {
        name: resolved.transfer.name,
        version: resolved.transfer.version,
      }
    }
  } else if (Assets.isRawAddress(currency)) {
    address = currency
  } else {
    throw new Error('EVM authorization requires `chainId`.')
  }

  if (!authorization) throw new Error('EVM authorization requires `authorization` metadata.')
  if (chainId === undefined) throw new Error('EVM authorization requires `chainId`.')
  if (decimals === undefined) throw new Error('EVM authorization requires `decimals`.')

  const x402 = X402.resolveOptions({
    authorization,
    options: config.x402,
  })
  const settle = config.settle ?? (x402?.facilitator ? X402.settleWithFacilitator(x402) : undefined)
  if (!settle) throw new Error('EVM authorization requires `settle` or `x402.facilitator`.')

  return {
    authorization,
    chainId,
    currency: getAddress(address),
    decimals,
    recipient: resolveRecipient({ chainId, recipient, x402: config.x402 }),
    settle,
    validate:
      !config.settle && x402.facilitator
        ? (parameters) => X402.verifyWithFacilitator(x402, parameters)
        : undefined,
    x402,
  }
}

/**
 * Fills a route's `recipient` from a resolver on each challenge.
 *
 * New challenges always carry the current address. A payment still verifies against an address
 * the resolver replaced less than its `grace` ago when the payment names it: the echoed challenge
 * of a native credential, or an x402 payment's `accepted.payTo`. Neither is trusted on its own
 * (both come from the caller, and a failed check re-issues a challenge from this request), so only
 * addresses this process issued qualify. An HMAC-valid echo is not enough: another route or worker
 * sharing the secret may have issued it for a different recipient.
 */
function recipientHook(resolver: X402Facilitator.PayToResolver) {
  return async ({
    credential,
    request,
  }: {
    credential?: Credential.Credential | null | undefined
    request: Record<string, unknown>
  }) => {
    if (request.recipient) return request as never
    let recipient: `0x${string}`
    try {
      recipient = await resolver()
    } catch (error) {
      throw new Errors.OfferUnavailableError({
        cause: error,
        reason: 'EVM charge recipient unavailable',
      })
    }
    const echoed = credential?.challenge.request as
      | { payTo?: unknown; recipient?: unknown }
      | undefined
    const named = credential
      ? X402.isPendingCredential(credential)
        ? echoed?.payTo
        : echoed?.recipient
      : undefined
    if (typeof named === 'string') {
      // Not seen yet: maybe just published. Re-read (rate-limited) before falling back.
      if (!resolver.issued(named)) recipient = await resolver.refresh().catch(() => recipient)
      recipient = resolver.issued(named) ?? recipient
    }
    return { ...request, recipient } as never
  }
}

/** Stands in for a lazy route's recipient in bindings: one this route issued, or none yet. */
const lazyRecipient = 'mppx:lazy-recipient'

/**
 * The fields a credential must match. Same as the default binding, but a route whose recipient is
 * read per challenge has none in its static form. Its recipient binds as {@link lazyRecipient},
 * and so does an echoed recipient only when this route issued it; any other address keeps its own
 * value. So a credential for a sibling offer with another recipient never matches this route, and
 * the challenge rebuilt at verification still pins the exact address.
 */
function chargeBinding(resolver: X402Facilitator.PayToResolver) {
  return (
    request:
      | z.output<typeof Methods.charge.schema.request>
      | (Record<string, unknown> & { chainId?: unknown; splits?: unknown }),
  ) => {
    const binding = chargeBindingFields(request)
    const { recipient } = binding
    return {
      ...binding,
      recipient:
        recipient === undefined ||
        (typeof recipient === 'string' && resolver.issued(recipient) !== undefined)
          ? lazyRecipient
          : recipient,
    }
  }
}

function chargeBindingFields(
  request:
    | z.output<typeof Methods.charge.schema.request>
    | (Record<string, unknown> & { chainId?: unknown; splits?: unknown }),
) {
  // Standalone matching may pass raw defaults (chainId and splits at the top level) when the
  // route-only amount is missing, rather than the transformed request.
  const { amount, currency, methodDetails, recipient } = request as {
    amount?: unknown
    currency?: unknown
    methodDetails?: { chainId?: unknown; splits?: unknown } | undefined
    recipient?: unknown
  }
  const raw = request as { chainId?: unknown; splits?: unknown }
  return {
    amount,
    chainId: methodDetails?.chainId ?? raw.chainId,
    currency,
    recipient,
    splits: methodDetails?.splits ?? raw.splits,
  }
}

function resolveRecipient(parameters: {
  chainId: number
  recipient: charge.RecipientConfig['recipient']
  x402: X402.Options | undefined
}): ResolvedConfig['recipient'] {
  const { chainId, recipient, x402 } = parameters
  if (typeof recipient === 'string') return getAddress(recipient)
  if (typeof recipient === 'function')
    return 'issued' in recipient
      ? (recipient as X402Facilitator.PayToResolver)
      : // Called for each challenge, as documented: no caching.
        X402Facilitator.createPayToResolver(async () => recipient(), { ttl: 0 })
  if (!x402?.facilitator)
    throw new Error(
      'EVM authorization requires `recipient` or an `x402.facilitator` that publishes `payTo`.',
    )
  return X402Facilitator.payToResolver(x402.facilitator, {
    fetch: x402.fetch,
    headers: x402.headers,
    network: Types.networkOf(chainId),
  })
}

function createPaths(config: ResolvedConfig): HttpPaths {
  return {
    mpp: createMppPath(),
    x402: X402.createPath(
      config.x402,
      typeof config.recipient === 'function' ? config.recipient : undefined,
    ),
  }
}

function createMppPath(): HttpPath {
  const transport = ServerTransport.http()
  return {
    credentialHeaders: transport.credentialHeaders ?? [],
    bindCredential: (options) => transport.bindCredential?.(options) ?? options.credential,
    captureRequest: transport.captureRequest,
    getCredential: transport.getCredential,
    respondChallenge: (options) => transport.respondChallenge(options),
    respondReceipt: (options, response) => transport.respondReceipt({ ...options, response }),
  }
}

function httpTransport(paths: HttpPaths): ServerTransport.Http {
  return ServerTransport.from<Request, Response>({
    name: 'evm-http',
    credentialHeaders: [
      ...new Set([...paths.mpp.credentialHeaders, ...paths.x402.credentialHeaders]),
    ],

    captureRequest: paths.mpp.captureRequest,

    getCredential(input) {
      return paths.mpp.getCredential(input) ?? paths.x402.getCredential(input)
    },

    matchCredential: paths.x402.matchCredential,

    bindCredential(options) {
      if (X402.isPendingCredential(options.credential)) return paths.x402.bindCredential(options)
      return paths.mpp.bindCredential?.(options) ?? options.credential
    },

    async respondChallenge(options) {
      const response = await paths.mpp.respondChallenge(options)
      return paths.x402.respondChallenge(options, response)
    },

    respondReceipt(options) {
      const response = paths.mpp.respondReceipt(options, options.response)
      return paths.x402.respondReceipt(options, response)
    },
  })
}

/**
 * SIWX nonces each request has claimed, per replay store, shared by the offers of a
 * composed route. Offers with their own stores each record the nonce in theirs.
 */
const siwxClaims = new WeakMap<Request, WeakMap<Store.AtomicStore, Set<string>>>()

/**
 * SIWX nonces an offer of each request found already used. Later offers of a composed
 * route refuse them too, so an offer whose store never saw the nonce can't accept a replay.
 */
const siwxReplays = new WeakMap<Request, Set<string>>()

/**
 * Grants a request that carries a valid x402 SIWX proof without payment, when the
 * server's `grant` approves the wallet. A request without a proof, or one `grant`
 * refuses, gets the route's 402; an invalid proof gets it with the spec's error code.
 */
function siwxAuthorize(siwx: Siwx.ServerOptions): Method.AuthorizeFn<typeof Methods.charge> {
  return async ({ input, request }) => {
    const value = input.headers.get(Siwx.header)
    if (!value) return undefined
    try {
      const payload = Siwx.decode(value)
      const proof = await Siwx.verify({
        chainId: request.methodDetails.chainId,
        options: siwx,
        payload,
      })
      // A copy, as canOffer and selectOffers get, so a grant that reads the body leaves it
      // for the route handler. Taken before the claim, so a body already read can't spend the
      // nonce: grant then gets the request without its body.
      const copy = cloneGrantInput(input)
      // The copy's body tees the request's, so it is cancelled once grant returns: an unread
      // copy would otherwise buffer everything the route handler later streams from the request.
      let granted: boolean
      try {
        // Reserve the nonce before grant, so a replayed proof never reaches grant. A claim this
        // request already made (a composed offer before this one declined) is shared, so a later
        // offer can still grant the wallet; a proof every offer declined stays spent, so it can't
        // be replayed once grant would approve the wallet. Clients sign a fresh proof each time.
        const stores = siwxClaims.get(input) ?? new WeakMap<Store.AtomicStore, Set<string>>()
        siwxClaims.set(input, stores)
        const claimed = stores.get(siwx.store) ?? new Set<string>()
        stores.set(siwx.store, claimed)
        const key = `${payload.nonce}:${payload.issuedAt}`
        const replays = siwxReplays.get(input) ?? new Set<string>()
        siwxReplays.set(input, replays)
        if (replays.has(key)) throw new Siwx.InvalidProofError('invalid_siwx_nonce')
        if (!claimed.has(key)) {
          try {
            await Siwx.claim({ payload, store: siwx.store })
          } catch (error) {
            if (error instanceof Siwx.InvalidProofError) replays.add(key)
            throw error
          }
          claimed.add(key)
        }
        granted = Boolean(await siwx.grant({ ...proof, request: copy }))
      } finally {
        releaseGrantInput(copy)
      }
      if (!granted) return undefined
      return {
        receipt: {
          method: Methods.charge.name,
          reference: Types.toSource({ address: proof.address, chainId: proof.chainId }),
          status: 'success',
          timestamp: new Date().toISOString(),
        },
      }
    } catch (error) {
      if (error instanceof Siwx.InvalidProofError)
        throw new VerificationFailedError({ reason: error.code })
      throw error
    }
  }
}

/** Clones a request for `grant`, falling back to a bodyless copy when its body was read. */
function cloneGrantInput(input: Request): Request {
  try {
    return input.clone()
  } catch {
    return new globalThis.Request(input.url, {
      headers: new Headers(input.headers),
      method: input.method,
      signal: input.signal,
    })
  }
}

/** Cancels a grant copy's body, so its tee branch stops buffering the request's body. */
function releaseGrantInput(copy: Request): void {
  if (!copy.body || copy.bodyUsed) return
  // Not awaited: a tee branch's cancel settles only once the other branch is done too.
  void copy.body.cancel().catch(() => {})
}

function assertAddressEqual(actual: string, expected: string, reason: string) {
  if (getAddress(actual) === getAddress(expected)) return
  throw new VerificationFailedError({ reason })
}

/** Largest serialized settle extensions a receipt carries; larger ones are dropped. */
const maxExtensionsBytes = 4096
/** Deepest nesting settle extensions may have; deeper ones are dropped. */
const maxExtensionsDepth = 8

/**
 * Normalizes settler extensions to the JSON the receipt header carries. A value that isn't a
 * plain JSON object, nests deeper than 8 levels or serializes past 4 KiB is dropped, so a settled
 * payment never fails on its receipt or overflows a client's header limit.
 */
function toJsonExtensions(extensions: unknown): Record<string, unknown> | undefined {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return undefined
  if (!withinDepth(extensions, maxExtensionsDepth)) return undefined
  try {
    const serialized = JSON.stringify(extensions)
    if (new TextEncoder().encode(serialized).byteLength > maxExtensionsBytes) return undefined
    const json = JSON.parse(serialized) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined
    return Object.keys(json).length ? (json as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Checks nesting without recursion, so hostile depth can't overflow the stack. */
function withinDepth(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]]
  let visited = 0
  while (stack.length) {
    const [node, depth] = stack.pop()!
    if (!node || typeof node !== 'object') continue
    if (depth > limit || ++visited > 10_000) return false
    for (const child of Object.values(node)) stack.push([child, depth + 1])
  }
  return true
}
