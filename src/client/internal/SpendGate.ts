import { ousd, pathusd, usdce } from 'viem/tokens'

import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import {
  BroadcastOutcomeUnknownError,
  PaymentLimitExceededError,
  ZoneSettlementPendingError,
} from '../../Errors.js'
import * as Expires from '../../Expires.js'
import * as x402_ChallengeBrand from '../../internal/x402/ChallengeBrand.js'
import * as x402_Header from '../../internal/x402/Header.js'
import * as x402_Types from '../../internal/x402/Types.js'
import type * as Method from '../../Method.js'
import * as PaymentRequest from '../../PaymentRequest.js'
import type * as Spend from '../Spend.js'
import * as FundsMoved from './FundsMoved.js'
import * as SpendHooks from './SpendHooks.js'

/** Spending options shared by `Mppx.create` and `Fetch.from`. */
export type Config = {
  /**
   * Most a single payment may cost, checked after a challenge is selected and before any
   * credential is created. A `Money` limit counts only tokens the client configures (`tokens`
   * and Tempo's built-in stablecoins); payments in other assets are refused.
   *
   * Setting any of `maxPayment`, `authorize` or `funders` limits payments to `charge`
   * challenges: sessions and subscriptions keep paying after one check, so they are refused.
   */
  maxPayment?: Spend.MaxPayment | undefined
  /**
   * Approves each payment after `maxPayment` and before funders and signing. Pass
   * `Budget.create({ total })` to cap total spend across payments.
   */
  authorize?: Spend.Authorize | undefined
  /** Funders run in order before each credential is signed, such as to swap funds into the wallet. */
  funders?: readonly Spend.Funder[] | undefined
  /**
   * Tokens whose `currency` and `decimals` the client trusts for `Money` limits, beside Tempo's
   * built-in stablecoins (pathUSD, USDC.e, OUSD).
   */
  tokens?: readonly Spend.Token[] | undefined
}

/** Settles one authorized payment, at most once. */
export type Settlement = Spend.Authorization

/** A payment that passed the spending checks, or one they let resume. */
export type Prepared = Readonly<{
  /** Commits or releases the payment's authorization. */
  settlement: Settlement
  /** What the method may do for it. */
  constraints: SpendHooks.Constraints
}>

/** Spending rules resolved from {@link Config}. */
export type Spender = {
  /** Normalizes a `charge` challenge, or returns `undefined` when it names no checkable payment. */
  resolve(challenge: Challenge.Challenge): Spend.Requirement | undefined
  /**
   * Checks the intent, expiry and `maxPayment`, runs the method's own policy, `authorize` and the
   * funders, and returns the settlement to commit or release. `undefined` when no spending option
   * is set, so payments run unchanged.
   *
   * With `method`, a payment that method already made and these options already counted, such as
   * an outstanding Zone withdrawal, resumes without a new reservation.
   */
  prepare:
    | ((
        challenge: Challenge.Challenge,
        options?: { method?: Method.AnyClient | undefined; signal?: AbortSignal | undefined },
      ) => Promise<Prepared>)
    | undefined
  /** The limit a refused credential names: `maxPayment` when it is set, else `budget`. */
  limit: PaymentLimitExceededError.Limit
}

type TokenMetadata = Readonly<{ currency: string; decimals: number }>

const tempoChainIds = [4217, 42431] as const
const builtinTokens = [ousd, pathusd, usdce]
/** Stripe charges USD in cents. */
const stripeTokens = [{ network: 'stripe', asset: 'usd', currency: 'USD', decimals: 2 }] as const
/** The only intent spending options can bound: one payment of a known amount. */
const chargeIntent = 'charge'
const issued = new WeakSet<object>()
const decimalPattern = /^(\d+)(?:\.(\d+))?$/
const maxDecimalLength = 1_024

/** Resolves and validates spending options once, at construction. */
export function from(config: Config): Spender {
  const { authorize, funders = [], maxPayment, tokens } = config
  if (maxPayment !== undefined) assertMaxPayment(maxPayment)
  if (authorize !== undefined && typeof authorize !== 'function')
    throw new TypeError('authorize must be a function.')
  if (!Array.isArray(funders) || funders.some((funder) => typeof funder?.fund !== 'function'))
    throw new TypeError('funders must be an array of objects with a fund function.')
  const metadata = tokenMetadata(tokens)
  const resolve = (challenge: Challenge.Challenge) => requirement(challenge, metadata)
  const enabled = maxPayment !== undefined || authorize !== undefined || funders.length > 0
  const limit = maxPayment === undefined ? 'budget' : 'maxPayment'
  return {
    limit,
    resolve(challenge) {
      if (challenge.intent !== chargeIntent) return undefined
      try {
        return resolve(challenge)
      } catch {
        return undefined
      }
    },
    prepare: enabled
      ? async (challenge, { method, signal } = {}) => {
          // A canceled request starts no authorization or funding.
          signal?.throwIfAborted()
          // A limit bounds one payment. Sessions and subscriptions keep paying after this check,
          // so only charges pass, before any method, hook or funder runs.
          if (challenge.intent !== chargeIntent)
            throw new PaymentLimitExceededError({ limit, reason: 'intent' })
          // An expired challenge cannot be paid, so nothing is authorized or funded for it.
          if (challenge.expires) Expires.assert(challenge.expires, challenge.id)
          const hooks = method && SpendHooks.get(method)
          // A payment the method already made was counted when it started: resume it as is.
          if (hooks?.resumes?.(challenge))
            return Object.freeze({
              settlement: once(undefined),
              constraints: Object.freeze({ limit, resume: true }),
            })
          const key = identity(challenge)
          const requirement = resolve(challenge)
          if (maxPayment !== undefined) assertWithin(requirement, maxPayment)
          // Refuse what the method would refuse before anything is reserved or funded.
          hooks?.assert?.(challenge)
          // Hooks get a frozen copy, so they cannot change what is signed.
          const context: Spend.Context = Object.freeze({
            challenge: snapshot(challenge),
            ...(signal ? { signal } : {}),
          })
          const plan: Spend.Plan = Object.freeze({ requirement })
          issued.add(plan)
          const settlement = once((await authorize?.(plan, context)) ?? undefined)
          try {
            for (const funder of funders) {
              signal?.throwIfAborted()
              await funder.fund(requirement, context)
            }
            signal?.throwIfAborted()
            if (identity(challenge) !== key)
              throw new Error('Cannot check spending limits: the challenge changed while checked.')
          } catch (error) {
            settlement.release()
            throw error
          }
          return Object.freeze({
            settlement,
            constraints: Object.freeze({ limit, resume: false }),
          })
        }
      : undefined,
  }
}

/** Whether a config sets any spending option. */
export function configured(config: Config | undefined): boolean {
  return (
    config !== undefined &&
    (config.maxPayment !== undefined ||
      config.authorize !== undefined ||
      (config.funders !== undefined && config.funders.length > 0) ||
      config.tokens !== undefined)
  )
}

/** The spending options of `config`, without its other fields. */
export function pick(config: Config): Config {
  const { authorize, funders, maxPayment, tokens } = config
  return {
    ...(authorize !== undefined && { authorize }),
    ...(funders !== undefined && { funders }),
    ...(maxPayment !== undefined && { maxPayment }),
    ...(tokens !== undefined && { tokens }),
  }
}

/**
 * The spending options a fetch built on `inner`'s mppx fetch uses: its own, else the ones
 * `inner` was built with, so rewrapping a limited fetch never drops its limits. Throws when both
 * set some, since neither set may silently replace the other.
 */
export function inherit(config: Config, inner: Config | undefined): Config {
  if (!configured(inner)) return pick(config)
  if (configured(config))
    throw new TypeError(
      'The fetch passed in already has spending options (maxPayment, authorize, funders or tokens). Set them on one fetch only.',
    )
  return inner!
}

/** Whether mppx issued `plan`, so its currency and decimals come from client configuration. */
export function isIssued(plan: unknown): plan is Spend.Plan {
  return typeof plan === 'object' && plan !== null && issued.has(plan)
}

/**
 * Commits `settlement` once `credential` is created, and releases it when creation fails. An
 * error after which funds may have moved commits instead, so limits never undercount.
 */
export function track(
  credential: Promise<string>,
  settlement: Settlement | undefined,
): Promise<string> {
  if (!settlement) return credential
  return credential.then(
    (value) => {
      settlement.commit()
      return value
    },
    (error) => {
      if (
        error instanceof ZoneSettlementPendingError ||
        error instanceof BroadcastOutcomeUnknownError ||
        FundsMoved.has(error)
      )
        settlement.commit()
      else settlement.release()
      throw error
    },
  )
}

/** One payment's spending checks while its credential is chosen. */
export type Payment = {
  /** Runs the spending checks and funders, once. */
  prepare(): Promise<Prepared | undefined>
  /**
   * Prepares the payment, then tracks the credential mppx creates for it, as {@link track} does,
   * except that a failure keeps the reservation for a credential a handler returns instead.
   * `create` gets the constraints to attach to the method's credential parameters.
   */
  track(
    create: (constraints: SpendHooks.Constraints | undefined) => Promise<string>,
  ): Promise<string>
  /**
   * Commits the payment for a credential mppx did not create. It reuses the prepared reservation,
   * so funders run once, unless mppx's own credential already committed it.
   */
  commit(): Promise<void>
  /**
   * Checks and commits a credential mppx did not create against the challenge it pays: the one
   * among `offered`, the challenges of the same response, that its MPP echo names exactly or whose
   * x402 requirements its x402 payload signs. That challenge's terms pass `maxPayment`,
   * `authorize` and the funders, reusing the prepared reservation when it is the selected
   * challenge. Returns that challenge, or `undefined` without spending options. Throws
   * {@link PaymentLimitExceededError} when the credential cannot be read or bound to exactly one
   * offer.
   */
  commitReplacement(
    credential: string,
    offered: readonly Challenge.Challenge[],
  ): Promise<Challenge.Challenge | undefined>
  /**
   * Frees the reservation when no credential is sent. A credential mppx is still creating settles
   * it first, so a payment it makes stays counted. A no-op once committed.
   */
  release(): Promise<void>
}

/**
 * Starts one payment for `challenge`, which `method` signs. Its credential is mppx's own or one
 * an event handler or `onChallenge` returns instead; either way `authorize` and the funders run
 * at most once for it.
 */
export function payment(
  spender: Spender,
  challenge: Challenge.Challenge,
  signal?: AbortSignal | undefined,
  method?: Method.AnyClient | undefined,
): Payment {
  let prepared: Promise<Prepared | undefined> | undefined
  // Whether mppx's own credential committed the reservation.
  let used = false
  // Settles when the credential mppx is creating does.
  let creating: Promise<void> | undefined
  const prepare = () =>
    (prepared ??= Promise.resolve(spender.prepare?.(challenge, { method, signal })))
  const commit = async () => {
    if (!spender.prepare) return
    // A canceled request sends nothing, so its reservation is released instead.
    signal?.throwIfAborted()
    const own = used ? undefined : await prepare()
    if (own && !own.constraints.resume) return own.settlement.commit()
    // A resumed payment reserved nothing, and a used reservation is taken: check this one anew.
    ;(await spender.prepare(challenge, { signal })).settlement.commit()
  }
  const release = async () => {
    await creating
    ;(await prepared?.catch(() => undefined))?.settlement.release()
  }
  return {
    prepare,
    async track(create) {
      const own = await prepare()
      // The request may have been canceled since its payment was prepared: sign nothing.
      if (own && signal?.aborted) {
        own.settlement.release()
        signal.throwIfAborted()
      }
      const credential = track(
        create(own?.constraints),
        own && {
          commit() {
            used = true
            own.settlement.commit()
          },
          release() {},
        },
      )
      creating = credential.then(
        () => {},
        () => {},
      )
      return credential
    },
    commit,
    async commitReplacement(credential, offered) {
      if (!spender.prepare) return undefined
      const paid = replacedChallenge(credential, offered)
      if (!paid) throw unbound(spender)
      if (tryIdentity(paid) === tryIdentity(challenge)) {
        await commit()
        return paid
      }
      // It pays another offer: free the selected one's reservation and check that offer instead.
      await release()
      await payment(spender, paid, signal).commit()
      return paid
    },
    release,
  }
}

/**
 * Identifies a challenge by everything its ID binds (realm, method, intent, request, expiry,
 * digest and opaque data) and the ID itself, so two offers that share an ID stay apart.
 */
export function identity(challenge: Challenge.Challenge): string {
  const { digest, expires, id, intent, meta, method, opaque, realm, request } = challenge
  return JSON.stringify([
    x402_ChallengeBrand.is(challenge),
    id,
    realm,
    method,
    intent,
    PaymentRequest.serialize(request),
    expires ?? null,
    digest ?? null,
    opaque ?? (meta !== undefined ? PaymentRequest.serialize(meta) : null),
  ])
}

function tryIdentity(challenge: Challenge.Challenge): string | undefined {
  try {
    return identity(challenge)
  } catch {
    return undefined
  }
}

/**
 * The one offered challenge a credential pays: the MPP challenge its echo repeats exactly, or the
 * x402 offer whose requirements its x402 payload accepts and signs. `undefined` when it cannot be
 * read, or matches no offer or several.
 */
function replacedChallenge(
  credential: string,
  offered: readonly Challenge.Challenge[],
): Challenge.Challenge | undefined {
  const matches = mppOffers(credential, offered) ?? x402Offers(credential, offered)
  return matches?.length === 1 ? matches[0] : undefined
}

/** MPP offers an MPP credential echoes, or `undefined` when it is no MPP credential. */
function mppOffers(credential: string, offered: readonly Challenge.Challenge[]) {
  let echoed: Challenge.Challenge
  try {
    echoed = Credential.deserialize(credential).challenge
  } catch {
    return undefined
  }
  const key = tryIdentity(echoed)
  if (key === undefined) return []
  return offered.filter((challenge) => tryIdentity(challenge) === key)
}

/** x402 offers an x402 `PAYMENT-SIGNATURE` payload pays, or `undefined` when it is none. */
function x402Offers(credential: string, offered: readonly Challenge.Challenge[]) {
  let payload: x402_Types.PaymentPayload
  try {
    payload = x402_Header.decodePaymentSignature(credential)
  } catch {
    return undefined
  }
  return offered.filter(
    (challenge) => x402_ChallengeBrand.is(challenge) && paysX402(payload, challenge),
  )
}

/**
 * Whether an x402 payload pays an x402 offer: it accepts exactly the offer's requirements, and
 * its signed transfer moves the required amount of the required asset to the required payee.
 */
function paysX402(payload: x402_Types.PaymentPayload, challenge: Challenge.Challenge): boolean {
  const parsed = x402_Types.PaymentRequirementsSchema.safeParse(challenge.request)
  if (!parsed.success) return false
  const required = parsed.data
  try {
    if (PaymentRequest.serialize(required) !== PaymentRequest.serialize(payload.accepted))
      return false
    const amount = BigInt(required.amount)
    const signed = payload.payload
    if ('authorization' in signed)
      return (
        sameAddress(signed.authorization.to, required.payTo) &&
        BigInt(signed.authorization.value) === amount
      )
    const { permitted, witness } = signed.permit2Authorization
    return (
      sameAddress(permitted.token, required.asset) &&
      BigInt(permitted.amount) === amount &&
      sameAddress(witness.to, required.payTo)
    )
  } catch {
    return false
  }
}

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

/** Refuses a credential whose payment cannot be bound to an offered challenge. */
function unbound(spender: Spender) {
  return new PaymentLimitExceededError({
    limit: spender.limit,
    reason: 'credential',
  })
}

/** A deeply frozen copy of `challenge`, keeping its x402 origin. */
function snapshot(challenge: Challenge.Challenge): Challenge.Challenge {
  let copy: Challenge.Challenge
  try {
    copy = structuredClone(challenge)
  } catch {
    copy = JSON.parse(JSON.stringify(challenge)) as Challenge.Challenge
  }
  if (x402_ChallengeBrand.is(challenge)) x402_ChallengeBrand.mark(copy)
  return deepFreeze(copy)
}

function deepFreeze<value>(value: value): value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Key identifying an asset on a network; EVM addresses and Stripe currencies match in any case. */
export function assetKey(network: string, asset: string): string {
  const canonical =
    /^0x[\da-fA-F]{40}$/.test(asset) || network === 'stripe' ? asset.toLowerCase() : asset
  return JSON.stringify([network, canonical])
}

/**
 * Parses a non-negative decimal into units at `decimals` places without floating point.
 * Digits beyond `decimals` are dropped, which only lowers a limit.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const [, integer = '0', fraction = ''] = decimalPattern.exec(value) ?? []
  return BigInt(`${integer}${fraction.slice(0, decimals).padEnd(decimals, '0')}`)
}

/** Rejects a `Money` value that is not a non-negative decimal in a named currency. */
export function assertMoney(money: unknown, name: string): asserts money is Spend.Money {
  const { currency, value } = (money ?? {}) as Partial<Record<'currency' | 'value', unknown>>
  if (typeof currency !== 'string' || !currency.trim())
    throw new TypeError(`${name} currency must be a non-empty string.`)
  if (typeof value !== 'string' || value.length > maxDecimalLength || !decimalPattern.test(value))
    throw new TypeError(`${name} value must be a non-negative decimal string.`)
}

/** Whether a value is an {@link Spend.AssetLimit}. */
export function isAssetLimit(value: unknown): value is Spend.AssetLimit {
  if (typeof value !== 'object' || value === null) return false
  const { amount, asset, network } = value as Partial<Record<keyof Spend.AssetLimit, unknown>>
  return (
    typeof network === 'string' &&
    network.length > 0 &&
    typeof asset === 'string' &&
    asset.length > 0 &&
    typeof amount === 'bigint' &&
    amount >= 0n
  )
}

function assertMaxPayment(maxPayment: Spend.MaxPayment) {
  if (!Array.isArray(maxPayment)) return assertMoney(maxPayment, 'maxPayment')
  const keys = new Set<string>()
  for (const limit of maxPayment as readonly unknown[]) {
    if (!isAssetLimit(limit))
      throw new TypeError('Each maxPayment limit needs a network, an asset and a bigint amount.')
    const key = assetKey(limit.network, limit.asset)
    if (keys.has(key)) throw new TypeError(`Duplicate maxPayment limit for ${limit.asset}.`)
    keys.add(key)
  }
}

function assertWithin(requirement: Spend.Requirement, maxPayment: Spend.MaxPayment) {
  const refuse = (reason: PaymentLimitExceededError.Reason) =>
    new PaymentLimitExceededError({ limit: 'maxPayment', reason })
  if (Array.isArray(maxPayment)) {
    const key = assetKey(requirement.network, requirement.asset)
    const limit = maxPayment.find((limit) => assetKey(limit.network, limit.asset) === key)
    if (!limit) throw refuse('asset')
    if (requirement.amount > limit.amount) throw refuse('amount')
    return
  }
  const money = maxPayment as Spend.Money
  // Set only from client configuration, never from the challenge.
  const { currency, decimals } = requirement
  if (currency === undefined || decimals === undefined) throw refuse('asset')
  if (currency.toUpperCase() !== money.currency.toUpperCase()) throw refuse('asset')
  if (requirement.amount > parseUnits(money.value, decimals)) throw refuse('amount')
}

/**
 * Normalizes a selected challenge. Currency and decimals come only from `tokens`: a server
 * that names another currency, or sends fewer decimals, cannot change what a limit counts.
 */
function requirement(
  challenge: Challenge.Challenge,
  tokens: ReadonlyMap<string, TokenMetadata>,
): Spend.Requirement {
  const fields = x402_ChallengeBrand.is(challenge) ? x402Fields(challenge) : mppFields(challenge)
  const token = tokens.get(assetKey(fields.network, fields.asset))
  const value = {
    method: challenge.method,
    intent: challenge.intent,
    ...fields,
    ...(token ? { currency: token.currency, decimals: token.decimals } : {}),
  }
  // Amounts are bigints, which JSON cannot hold: serialize them as decimal strings.
  Object.defineProperty(value, 'toJSON', { value: requirementJson })
  return Object.freeze(value)
}

function requirementJson(this: Spend.Requirement) {
  return {
    ...this,
    amount: this.amount.toString(),
    ...(this.splits && {
      splits: this.splits.map((split) => ({ ...split, amount: split.amount.toString() })),
    }),
  }
}

function x402Fields(challenge: Challenge.Challenge) {
  const parsed = x402_Types.PaymentRequirementsSchema.safeParse(challenge.request)
  if (!parsed.success) throw new Error('Cannot check spending limits: invalid x402 requirements.')
  const { amount, asset, network, payTo } = parsed.data
  return {
    protocol: 'x402' as const,
    network,
    asset,
    amount: atomicAmount(amount),
    recipient: payTo,
  }
}

function mppFields(challenge: Challenge.Challenge) {
  const request = challenge.request as Record<string, unknown>
  const details = (
    typeof request.methodDetails === 'object' && request.methodDetails !== null
      ? request.methodDetails
      : {}
  ) as Record<string, unknown>
  // Methods sign on `methodDetails.chainId` and ignore a top-level `chainId`, so only the former
  // names the network. A top-level one it does not match could mean another chain: refuse it.
  const chainId = details.chainId
  if (chainId !== undefined && (!Number.isSafeInteger(chainId) || (chainId as number) <= 0))
    throw new Error('Cannot check spending limits: invalid challenge chain ID.')
  if (request.chainId !== undefined && request.chainId !== chainId)
    throw new Error(
      'Cannot check spending limits: challenge names a chain outside methodDetails.chainId.',
    )
  const asset = request.currency
  if (typeof asset !== 'string' || !asset)
    throw new Error('Cannot check spending limits: challenge names no currency.')
  const amount = atomicAmount(request.amount)
  const recipient = payee(challenge.method, request, details)
  const splits = paymentSplits(details.splits, amount)
  return {
    protocol: 'mpp' as const,
    network: chainId === undefined ? challenge.method : `eip155:${chainId}`,
    asset,
    amount,
    ...(recipient !== undefined ? { recipient } : {}),
    ...(splits ? { splits } : {}),
  }
}

/**
 * The payee a credential authorizes. Stripe creates its Shared Payment Token for
 * `methodDetails.networkId` and ignores `recipient`, so for Stripe that is the payee.
 */
function payee(
  method: string,
  request: Record<string, unknown>,
  details: Record<string, unknown>,
): string | undefined {
  if (method === 'stripe') {
    if (typeof details.networkId !== 'string' || !details.networkId)
      throw new Error('Cannot check spending limits: Stripe challenge names no networkId.')
    return details.networkId
  }
  return typeof request.recipient === 'string' ? request.recipient : undefined
}

/** Split payees and their shares, which a Tempo charge pays out of `amount`. */
function paymentSplits(value: unknown, amount: bigint): Spend.Requirement['splits'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Cannot check spending limits: invalid payment splits.')
  let total = 0n
  const splits = value.map((split: unknown) => {
    const { amount, recipient } = (split ?? {}) as Record<string, unknown>
    if (typeof recipient !== 'string' || !recipient)
      throw new Error('Cannot check spending limits: payment split names no recipient.')
    const share = atomicAmount(amount)
    total += share
    return Object.freeze({ recipient, amount: share })
  })
  // The signer refuses splits that leave the primary recipient nothing.
  if (total >= amount)
    throw new Error('Cannot check spending limits: payment splits are not less than the amount.')
  return Object.freeze(splits)
}

/** Parses an atomic amount as the signers do: any string of digits, leading zeroes included. */
function atomicAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error('Cannot check spending limits: challenge amount is not an atomic integer.')
  return BigInt(value)
}

/** Built-in tokens, then configured ones, keyed by {@link assetKey}; configured ones win. */
function tokenMetadata(tokens: readonly Spend.Token[] | undefined): Map<string, TokenMetadata> {
  const metadata = new Map<string, TokenMetadata>()
  for (const token of builtinTokens)
    for (const chainId of tempoChainIds) {
      const address = (token.addresses as Record<number, string | undefined>)[chainId]
      if (address)
        metadata.set(assetKey(`eip155:${chainId}`, address), {
          currency: token.currency!,
          decimals: token.decimals,
        })
    }
  for (const { asset, currency, decimals, network } of stripeTokens)
    metadata.set(assetKey(network, asset), { currency, decimals })
  if (tokens === undefined) return metadata
  if (!Array.isArray(tokens)) throw new TypeError('tokens must be an array.')
  const configured = new Map<string, TokenMetadata>()
  for (const token of tokens as readonly Spend.Token[]) {
    const { currency, decimals } = (token ?? {}) as Partial<Spend.Token>
    if (typeof currency !== 'string' || !currency.trim())
      throw new TypeError('Each token needs a currency, such as USD.')
    if (
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    )
      throw new TypeError('Token decimals must be an integer from 0 to 255.')
    const entries: [number, unknown][] =
      typeof token === 'function'
        ? Object.entries(token.addresses).map(([chainId, address]) => [Number(chainId), address])
        : [[token.chainId, token.address]]
    for (const [chainId, address] of entries) {
      if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof address !== 'string' || !address)
        throw new TypeError('Each token needs an address and a chain ID.')
      const key = assetKey(`eip155:${chainId}`, address)
      const existing = configured.get(key)
      if (
        existing &&
        (existing.currency.toUpperCase() !== currency.toUpperCase() ||
          existing.decimals !== decimals)
      )
        throw new TypeError(`tokens configure conflicting metadata for ${address}.`)
      configured.set(key, Object.freeze({ currency, decimals }))
    }
  }
  for (const [key, value] of configured) metadata.set(key, value)
  return metadata
}

function once(authorization: Spend.Authorization | undefined): Settlement {
  let open = true
  const close = (settle: (() => void) | undefined) => {
    if (!open) return
    open = false
    settle?.call(authorization)
  }
  return Object.freeze({
    commit: () => close(authorization?.commit),
    release: () => close(authorization?.release),
  })
}
