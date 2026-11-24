import { ousd, pathusd, usdce } from 'viem/tokens'

import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import {
  BroadcastOutcomeUnknownError,
  PaymentLimitExceededError,
  ZoneSettlementPendingError,
} from '../../Errors.js'
import * as x402_ChallengeBrand from '../../internal/x402/ChallengeBrand.js'
import * as x402_Types from '../../internal/x402/Types.js'
import * as PaymentRequest from '../../PaymentRequest.js'
import type * as Spend from '../Spend.js'
import * as FundsMoved from './FundsMoved.js'

/** Spending options shared by `Mppx.create` and `Fetch.from`. */
export type Config = {
  /**
   * Most a single payment may cost, checked after a challenge is selected and before any
   * credential is created. A `Money` limit counts only tokens the client configures (`tokens`
   * and Tempo's built-in stablecoins); payments in other assets are refused.
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

/** Spending rules resolved from {@link Config}. */
export type Spender = {
  /** Normalizes a challenge, or returns `undefined` when it names no checkable amount. */
  resolve(challenge: Challenge.Challenge): Spend.Requirement | undefined
  /**
   * Checks `maxPayment`, runs `authorize` and the funders, and returns the settlement to commit
   * or release. `undefined` when no spending option is set, so payments run unchanged.
   *
   * `amount` replaces the challenge's amount for a payment the method makes on its own while
   * handling a paid response, such as the increment of a streamed session voucher.
   */
  prepare:
    | ((
        challenge: Challenge.Challenge,
        signal?: AbortSignal | undefined,
        amount?: bigint | undefined,
      ) => Promise<Settlement>)
    | undefined
  /** The limit a refused credential names: `maxPayment` when it is set, else `budget`. */
  limit: PaymentLimitExceededError.Limit
}

type TokenMetadata = Readonly<{ currency: string; decimals: number }>

const tempoChainIds = [4217, 42431] as const
const builtinTokens = [ousd, pathusd, usdce]
/** Stripe charges USD in cents. */
const stripeTokens = [{ network: 'stripe', asset: 'usd', currency: 'USD', decimals: 2 }] as const
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
  return {
    limit: maxPayment === undefined ? 'budget' : 'maxPayment',
    resolve(challenge) {
      try {
        return resolve(challenge)
      } catch {
        return undefined
      }
    },
    prepare: enabled
      ? async (challenge, signal, amount) => {
          // A canceled request starts no authorization or funding.
          signal?.throwIfAborted()
          const resolved = resolve(challenge)
          const requirement =
            amount === undefined ? resolved : Object.freeze({ ...resolved, amount })
          if (maxPayment !== undefined) assertWithin(requirement, maxPayment)
          const context: Spend.Context = Object.freeze({
            challenge,
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
          } catch (error) {
            settlement.release()
            throw error
          }
          return settlement
        }
      : undefined,
  }
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
  prepare(): Promise<Settlement | undefined>
  /**
   * Prepares the payment, then tracks the credential mppx creates for it, as {@link track} does,
   * except that a failure keeps the reservation for a credential a handler returns instead.
   */
  track(create: () => Promise<string>): Promise<string>
  /**
   * Commits the payment for a credential mppx did not create. It reuses the prepared reservation,
   * so funders run once, unless mppx's own credential already committed it.
   */
  commit(): Promise<void>
  /**
   * Checks and commits a credential mppx did not create against the challenge it pays: the one
   * its echo names among `offered`, the challenges of the same response. That challenge's terms
   * pass `maxPayment`, `authorize` and the funders, reusing the prepared reservation when it is
   * the selected challenge. Throws {@link PaymentLimitExceededError} when the credential cannot be
   * read or echoes a challenge the response did not offer.
   */
  commitReplacement(credential: string, offered: readonly Challenge.Challenge[]): Promise<void>
  /** Frees the reservation when no credential is sent. A no-op once committed. */
  release(): Promise<void>
}

/**
 * Starts one payment for `challenge`. Its credential is mppx's own or one an event handler or
 * `onChallenge` returns instead; either way `authorize` and the funders run at most once for it.
 */
export function payment(
  spender: Spender,
  challenge: Challenge.Challenge,
  signal?: AbortSignal | undefined,
): Payment {
  let prepared: Promise<Settlement | undefined> | undefined
  // Whether mppx's own credential committed the reservation.
  let used = false
  const prepare = () => (prepared ??= Promise.resolve(spender.prepare?.(challenge, signal)))
  const commit = async () => {
    if (!spender.prepare) return
    // A canceled request sends nothing, so its reservation is released instead.
    signal?.throwIfAborted()
    if (used) (await spender.prepare(challenge, signal)).commit()
    else (await prepare())?.commit()
  }
  const release = async () => {
    ;(await prepared?.catch(() => undefined))?.release()
  }
  return {
    prepare,
    async track(create) {
      const settlement = await prepare()
      // The request may have been canceled since its payment was prepared: sign nothing.
      if (settlement && signal?.aborted) {
        settlement.release()
        signal.throwIfAborted()
      }
      return track(
        create(),
        settlement && {
          commit() {
            used = true
            settlement.commit()
          },
          release() {},
        },
      )
    },
    commit,
    async commitReplacement(credential, offered) {
      if (!spender.prepare) return
      const paid = replacedChallenge(credential, offered)
      if (!paid) throw unbound(spender)
      if (paid.id === challenge.id) return commit()
      // It pays another offer: free the selected one's reservation and check that offer instead.
      await release()
      await payment(spender, paid, signal).commit()
    },
    release,
  }
}

/**
 * The offered challenge a credential echoes: the one with its ID whose method, intent and request
 * it repeats. `undefined` when it cannot be read as an MPP credential or names no offer.
 */
function replacedChallenge(
  credential: string,
  offered: readonly Challenge.Challenge[],
): Challenge.Challenge | undefined {
  let echoed: Challenge.Challenge
  try {
    echoed = Credential.deserialize(credential).challenge
  } catch {
    return undefined
  }
  const match = offered.find((challenge) => challenge.id === echoed.id)
  if (!match || match.method !== echoed.method || match.intent !== echoed.intent) return undefined
  try {
    if (PaymentRequest.serialize(match.request) !== PaymentRequest.serialize(echoed.request))
      return undefined
  } catch {
    return undefined
  }
  return match
}

/** Refuses a credential whose payment cannot be bound to an offered challenge. */
function unbound(spender: Spender) {
  return new PaymentLimitExceededError({
    limit: spender.limit,
    reason: 'credential',
  })
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
  return Object.freeze({
    method: challenge.method,
    intent: challenge.intent,
    ...fields,
    ...(token ? { currency: token.currency, decimals: token.decimals } : {}),
  })
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
  return {
    protocol: 'mpp' as const,
    network: chainId === undefined ? challenge.method : `eip155:${chainId}`,
    asset,
    amount: atomicAmount(request.amount),
    ...(typeof request.recipient === 'string' ? { recipient: request.recipient } : {}),
  }
}

function atomicAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
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
