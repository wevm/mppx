import type * as Hex from 'ox/Hex'
import { type Address, parseUnits } from 'viem'
import {
  prepareTransactionRequest,
  sendCallsSync,
  sendTransactionSync,
  signTypedData,
  signTransaction,
} from 'viem/actions'
import { Actions } from 'viem/tempo'
import { tempo as tempo_chain } from 'viem/tempo/chains'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as AutoSwap from '../internal/auto-swap.js'
import * as Charge_internal from '../internal/charge.js'
import * as defaults from '../internal/defaults.js'
import { defaultFeeTokens, resolveFeeToken } from '../internal/fee-token.js'
import * as MachineTokenCharge from '../internal/machine-token-charge.js'
import * as Proof from '../internal/proof.js'
import * as Methods from '../Methods.js'
import type * as AccountResolution from './ResolveAccount.js'

/** Runtime context accepted by the Tempo charge client method. */
export type ChargeContext = {
  account?: Account.getResolver.Parameters['account'] | undefined
  autoSwap?: AutoSwap.resolve.Value | undefined
  mode?: Methods.ChargeMode | undefined
}

/** Default `validBefore` window for expiring-nonce charge transactions. */
const validBeforeSeconds = 25
/** Maximum number of challenges whose credentials are cached per charge client. */
const maxCachedCredentials = 256

type CreateCredentialParameters = Parameters<
  Method.CreateCredentialFn<typeof Methods.charge, ChargeContext>
>[0]

const chargeContextSchema = z.object({
  account: z.optional(z.custom<ChargeContext['account']>()),
  autoSwap: z.optional(z.custom<ChargeContext['autoSwap']>()),
  mode: z.optional(z.enum(Methods.chargeModes)),
})

/**
 * Creates a Tempo charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { tempo } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = tempo.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const { clientId } = parameters
  // Caps are denominated in the challenge currency, so they require a currency pin.
  if (
    (parameters.maxAmount !== undefined || parameters.maxAtomicAmount !== undefined) &&
    parameters.currencies === undefined
  )
    throw new Error('Tempo charge maxAmount and maxAtomicAmount require currencies.')
  const caps = {
    maxAmount: parseMaxAmount(parameters.maxAmount, parameters.decimals),
    maxAtomicAmount:
      parameters.maxAtomicAmount === undefined ? undefined : BigInt(parameters.maxAtomicAmount),
  }
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })
  const signOnce = createCredentialCache()

  return Method.toClient(Methods.charge, {
    // Skip offers that violate client policy so an acceptable offer can be chosen.
    canHandleChallenge({ challenge }) {
      try {
        assertChallengePolicy(parameters, caps, challenge.request as ChargeRequest)
        return true
      } catch {
        return false
      }
    },
    context: chargeContextSchema,

    // Sign each challenge at most once per signer, so a repeated challenge cannot
    // yield two independently settleable transactions.
    async createCredential(options) {
      // Enforce client policy before returning a cached credential, too.
      assertChallengePolicy(parameters, caps, options.challenge.request)
      const account = options.context?.account ?? parameters.account
      const signer = (typeof account === 'string' ? account : account?.address)?.toLowerCase()
      return signOnce(
        `${signer ?? ''}:${options.challenge.id}`,
        options.challenge.expires,
        (validBefore) => createChargeCredential(options, validBefore),
      )
    },
  })

  async function createChargeCredential(
    { challenge, context }: CreateCredentialParameters,
    validBefore: number,
  ): Promise<string> {
    // Sign on the pinned chain when the challenge omits a chain ID.
    const challengeChainId = challenge.request.methodDetails?.chainId
    const resolvedChainId =
      challengeChainId ??
      parameters.expectedChainId ??
      (parameters.allowedChainIds?.length === 1 ? parameters.allowedChainIds[0] : undefined)
    const client = await getClient({ chainId: resolvedChainId })
    Client.assertChainId(client, resolvedChainId)
    const chainId = resolvedChainId ?? client.chain?.id
    Client.assertAllowedChainId(parameters.allowedChainIds, chainId)
    if (chainId === undefined)
      throw new Error('No `chainId` provided. Pass a chain ID in the challenge or client.')

    const { request } = challenge
    const { amount, methodDetails } = request
    const supportedModes = (methodDetails?.supportedModes as
      | readonly Methods.ChargeMode[]
      | undefined) ?? ['pull', 'push']
    const defaultAccount = getAccount(client, context)
    const resolveAccount = async (operation: AccountResolution.ResolveAccountOperation) =>
      (await parameters.resolveAccount?.({
        account: defaultAccount,
        chainId,
        operation,
      })) ?? defaultAccount

    // Zero-amount: sign EIP-712 typed data instead of creating a transaction.
    if (BigInt(amount) === 0n) {
      const account = await resolveAccount({ kind: 'signPaymentProof' })
      const signature = await signTypedData(client, {
        account,
        // `account` here is the signing account; the proof's bound payer is
        // `account.address` (echoed in the credential `source` below).
        ...Proof.typedData({
          account: account.address,
          chainId,
          challengeId: challenge.id,
          realm: challenge.realm,
        }),
      })
      return Credential.serialize({
        challenge,
        payload: { signature, type: 'proof' },
        source: Proof.proofSource({ address: account.address, chainId }),
      })
    }

    const currency = request.currency as Address
    const isMachineTokenCurrency = MachineTokenCharge.isMachineToken({ chainId, currency })
    const memo = Attribution.encode({
      challengeId: challenge.id,
      clientId,
      serverId: challenge.realm,
    })
    const transfers = Charge_internal.getTransfers({
      amount,
      methodDetails: {
        ...methodDetails,
        memo,
      },
      recipient: request.recipient as Address,
    })
    const transferCalls = transfers.map((transfer): AccountResolution.ResolveAccountCall =>
      Actions.token.transfer.call(client, {
        amount: BigInt(transfer.amount),
        ...(transfer.memo && { memo: transfer.memo as Hex.Hex }),
        to: transfer.recipient as Address,
        token: currency,
      }),
    )

    const autoSwap = AutoSwap.resolve(
      context?.autoSwap ?? parameters.autoSwap,
      AutoSwap.defaultCurrencies,
    )
    const machineTokenEnabled = methodDetails?.machineTokenEnabled === true

    const machineTokenCandidate = machineTokenEnabled
      ? MachineTokenCharge.getRoute({ chainId, currency, transfers })
      : undefined
    let account = defaultAccount
    let machineTokenRoute: typeof machineTokenCandidate
    if (machineTokenCandidate) {
      const machineTokenAccount = await (async () => {
        try {
          return await resolveAccount({
            calls: machineTokenCandidate.calls,
            kind: 'executeCalls',
          })
        } catch {
          // A machine-token route is optional. A scoped account that cannot
          // execute it may still be able to satisfy the direct payment.
          return undefined
        }
      })()
      if (machineTokenAccount) {
        machineTokenRoute = await MachineTokenCharge.findRoute(client, {
          account: machineTokenAccount.address,
          chainId,
          currency,
          transfers,
        })
        if (machineTokenRoute) account = machineTokenAccount
      }
    }

    let swapCalls: Awaited<ReturnType<typeof AutoSwap.findCalls>>
    if (!machineTokenRoute) {
      account = await resolveAccount({
        kind: 'executeCalls',
        ...(autoSwap ? {} : { calls: transferCalls }),
      })
      swapCalls = autoSwap
        ? await AutoSwap.findCalls(client, {
            account: account.address,
            amountOut: BigInt(amount),
            tokenOut: currency,
            tokenIn: autoSwap.tokenIn,
            slippage: autoSwap.slippage,
          })
        : undefined
    }

    const calls = machineTokenRoute?.calls ?? [...(swapCalls ?? []), ...transferCalls]
    const allowedFeeTokens = defaultFeeTokens(chainId)
    const feeToken =
      machineTokenRoute || isMachineTokenCurrency
        ? await resolveFeeToken({
            account: account.address,
            allowedTokens: allowedFeeTokens,
            candidateTokens: allowedFeeTokens,
            client,
            prioritizeCandidates: true,
          })
        : undefined

    const mode = (() => {
      const explicitMode = context?.mode ?? parameters.mode
      if (explicitMode) {
        if (!supportedModes.includes(explicitMode))
          throw new Error(`Challenge does not support ${explicitMode} mode.`)
        return explicitMode
      }

      const preferredMode = account.type === 'json-rpc' ? 'push' : 'pull'
      if (supportedModes.includes(preferredMode)) return preferredMode
      return supportedModes[0]!
    })()

    if (mode === 'push') {
      const { receipts } =
        account.type === 'local'
          ? {
              receipts: [
                await sendTransactionSync(client, {
                  account,
                  calls,
                  ...(feeToken ? { feeToken } : {}),
                  nonceKey: 'expiring',
                  validBefore,
                } as never),
              ],
            }
          : await sendCallsSync(client, {
              account,
              ...(feeToken ? { capabilities: { feeToken } } : {}),
              calls: calls as never,
              experimental_fallback: calls.length === 1,
              forceAtomic: calls.length > 1,
            })
      const hash = receipts?.[0]?.transactionHash
      if (!hash) throw new Error('No transaction receipt returned.')
      return Credential.serialize({
        challenge,
        payload: { hash, type: 'hash' },
        source: Proof.proofSource({ address: account.address, chainId }),
      })
    }

    const prepared = await prepareTransactionRequest(client, {
      account,
      calls,
      ...(feeToken ? { feeToken } : {}),
      nonceKey: 'expiring',
      validBefore,
    } as never)
    // Estimate before enabling fee-payer mode so Tempo includes sender
    // signature and access-key verification costs in the gas budget.
    prepared.gas = (prepared.gas ?? 0n) + 5_000n
    if (methodDetails?.feePayer) {
      const sponsored = prepared as Record<string, unknown>
      delete sponsored.feePayerSignature
      delete sponsored.feeToken
      sponsored.feePayer = true
    }
    const signature = await signTransaction(client, prepared as never)

    return Credential.serialize({
      challenge,
      payload: { signature, type: 'transaction' },
      source: Proof.proofSource({ address: account.address, chainId }),
    })
  }
}

/**
 * Returns an expiring-nonce `validBefore` capped at the challenge expiry.
 *
 * `validBefore` is an exclusive whole-second bound, so the cap is the second
 * after the (possibly fractional) expiry. The transaction then stays valid for
 * as long as the challenge does.
 */
function getValidBefore(expires: string | undefined): number {
  const validBefore = Math.floor(Date.now() / 1000) + validBeforeSeconds
  if (!expires) return validBefore
  const challengeExpiry = Math.floor(new Date(expires).getTime() / 1000)
  if (!Number.isFinite(challengeExpiry)) return validBefore
  return Math.min(validBefore, challengeExpiry + 1)
}

/**
 * Caches credentials by signer and challenge. Repeated and concurrent calls share
 * one credential until its transaction's `validBefore` passes, after which the
 * transaction can no longer settle. Failed attempts are not cached.
 */
function createCredentialCache() {
  type Entry = { expiresAt?: number | undefined; promise: Promise<string> }
  const entries = new Map<string, Entry>()

  return (
    key: string,
    expires: string | undefined,
    create: (validBefore: number) => Promise<string>,
  ) => {
    const now = Date.now()
    for (const [k, entry] of entries)
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) entries.delete(k)

    const cached = entries.get(key)
    if (cached) return cached.promise

    const validBefore = getValidBefore(expires)
    const entry: Entry = {
      promise: create(validBefore).then(
        (credential) => {
          entry.expiresAt = validBefore * 1000
          return credential
        },
        (error) => {
          if (entries.get(key) === entry) entries.delete(key)
          throw error
        },
      ),
    }
    entries.set(key, entry)
    if (entries.size > maxCachedCredentials) entries.delete(entries.keys().next().value as string)
    return entry.promise
  }
}

/** Parses `maxAmount` to base units, rejecting values that cannot be represented exactly. */
function parseMaxAmount(maxAmount: string | undefined, decimals: number | undefined) {
  if (maxAmount === undefined) return undefined
  if (decimals === undefined) throw new Error('Tempo charge maxAmount requires currency decimals.')
  // `parseUnits` rounds excess fractional digits, which could loosen the cap.
  const fraction = maxAmount.split('.')[1]?.replace(/0+$/, '') ?? ''
  if (fraction.length > decimals)
    throw new Error(
      `Tempo charge maxAmount ${maxAmount} has more fractional digits than ${decimals} decimals allow.`,
    )
  return parseUnits(maxAmount, decimals)
}

type ChargeRequest = z.output<typeof Methods.charge.schema.request>

/**
 * Rejects a challenge whose chain, currency, recipients, or amount violate the client policy.
 * Runs during challenge selection and again before any client, account, or signing work.
 */
function assertChallengePolicy(
  parameters: charge.Parameters,
  caps: { maxAmount: bigint | undefined; maxAtomicAmount: bigint | undefined },
  request: ChargeRequest,
) {
  const { amount, methodDetails, recipient } = request

  // Chain pinning: reject a challenge whose chain ID conflicts with the pinned one.
  const challengeChainId = methodDetails?.chainId
  if (
    parameters.expectedChainId !== undefined &&
    challengeChainId !== undefined &&
    challengeChainId !== parameters.expectedChainId
  )
    throw new Error(
      `Chain ID mismatch: expected ${parameters.expectedChainId}, got ${challengeChainId}.`,
    )
  if (challengeChainId !== undefined || parameters.allowedChainIds?.length === 0)
    Client.assertAllowedChainId(parameters.allowedChainIds, challengeChainId)

  if (
    parameters.currencies &&
    !parameters.currencies.some((c) => c.toLowerCase() === request.currency.toLowerCase())
  )
    throw new Error(`Tempo charge currency is not allowed: ${request.currency}.`)

  if (parameters.expectedRecipients) {
    const allowed = new Set(parameters.expectedRecipients.map((a) => a.toLowerCase()))
    if (!recipient || !allowed.has(recipient.toLowerCase()))
      throw new Error(`Unexpected primary recipient: ${recipient}`)
    const splits = methodDetails?.splits as readonly { recipient: string }[] | undefined
    if (splits) {
      for (const split of splits) {
        if (!allowed.has(split.recipient.toLowerCase()))
          throw new Error(`Unexpected split recipient: ${split.recipient}`)
      }
    }
  }

  if (caps.maxAtomicAmount !== undefined && BigInt(amount) > caps.maxAtomicAmount)
    throw new Error('Tempo charge amount exceeds maxAtomicAmount.')
  if (caps.maxAmount !== undefined && BigInt(amount) > caps.maxAmount)
    throw new Error('Tempo charge amount exceeds maxAmount.')
}

export declare namespace charge {
  type AutoSwap = AutoSwap.resolve.Value
  type Context = ChargeContext
  type ResolveAccount = AccountResolution.ResolveAccount
  type ResolveAccountInfo = AccountResolution.ResolveAccountInfo

  type Parameters = {
    /**
     * Automatically swap from a fallback currency (pathUsd, USDC.e) via the
     * Tempo DEX when the user lacks sufficient balance of the target currency.
     *
     * @default false
     */
    autoSwap?: AutoSwap | undefined
    /** Client identifier used to derive the client fingerprint in attribution memos. */
    clientId?: string | undefined
    /**
     * Chain ID this client is willing to pay on. When set, the client rejects
     * any challenge whose `methodDetails.chainId` differs, and signs on this
     * chain when the challenge omits a chain ID.
     */
    expectedChainId?: number | undefined
    /**
     * Chains permitted for payment credentials. Omitted allows any chain; empty rejects all.
     * A single entry supplies an omitted challenge chain unless `expectedChainId` is set.
     * When both policies are set, the selected chain must satisfy both.
     */
    allowedChainIds?: readonly number[] | undefined
    /**
     * Allowlist of payment recipient addresses. When set, both the primary
     * recipient and every split recipient must be included in this list.
     */
    expectedRecipients?: readonly Address[] | undefined
    /**
     * Allowlist of TIP-20 currency addresses this client will pay in, compared
     * case-insensitively. Offers in other currencies are skipped during selection
     * and rejected before signing; an empty list rejects all. Required with
     * `maxAmount` or `maxAtomicAmount`, which are denominated in the challenge currency.
     */
    currencies?: readonly Address[] | undefined
    /**
     * Decimals of the `currencies`, used to parse `maxAmount`. Required with
     * `maxAmount` because challenges do not carry currency decimals.
     */
    decimals?: number | undefined
    /**
     * Maximum display-unit amount (e.g. `'1.5'`) the client is willing to pay per
     * charge, parsed with `decimals`. Values with more fractional digits than
     * `decimals` are rejected rather than rounded. Compared against the challenge
     * amount, which includes splits; larger offers are skipped during selection and
     * rejected before signing. Applies per credential, not cumulatively across
     * payment retries. Requires `currencies`.
     */
    maxAmount?: string | undefined
    /**
     * Maximum amount the client is willing to pay per charge, in raw base units of
     * the challenge currency (compared directly with the challenge `amount`).
     * Checked like `maxAmount`. Requires `currencies`.
     */
    maxAtomicAmount?: string | undefined
    /**
     * Controls how the charge transaction is submitted.
     *
     * - `'push'`: Client broadcasts the transaction and sends the tx hash to the server.
     * - `'pull'`: Client signs the transaction and sends the serialized tx to the server for broadcast.
     *
     * If the server advertises `supportedModes`, this setting must be one of
     * the supported values for the challenge.
     *
     * @default `'push'` for JSON-RPC accounts, `'pull'` for local accounts.
     */
    mode?: Methods.ChargeMode | undefined
    /** Selects the account that signs this charge after the challenge and chain are known. */
    resolveAccount?: ResolveAccount | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
