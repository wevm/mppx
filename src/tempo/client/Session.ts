import type { Hex } from 'ox'
import { type Address, parseUnits, type Account as viem_Account } from 'viem'
import { tempo as tempo_chain } from 'viem/tempo/chains'

import type * as Challenge from '../../Challenge.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import { getAccountSignerAddress } from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import * as SessionActions from '../Session.js'
import { resolveEscrow, tryRecoverChannel } from './ChannelOps.js'

export const sessionContextSchema = z.object({
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
  action: z.optional(z.enum(['open', 'topUp', 'voucher', 'close'])),
  channelId: z.optional(z.string()),
  cumulativeAmount: z.optional(z.amount()),
  cumulativeAmountRaw: z.optional(z.string()),
  transaction: z.optional(z.string()),
  additionalDeposit: z.optional(z.amount()),
  additionalDepositRaw: z.optional(z.string()),
  depositRaw: z.optional(z.string()),
})

export type SessionContext = z.infer<typeof sessionContextSchema>

/**
 * Creates a session payment method for use with `Mppx.create()`.
 *
 * Supports both auto mode (set `deposit` to manage channels automatically)
 * and manual mode (pass `context.action` to control each step).
 *
 * @example
 * ```ts
 * // Auto mode
 * import { Mppx, tempo } from 'mppx/client'
 *
 * const mppx = Mppx.create({
 *   methods: [tempo({
 *     account: privateKeyToAccount('0x...'),
 *     deposit: '10',
 *   })],
 * })
 *
 * const res = await mppx.fetch('/api/chat?prompt=hello')
 * ```
 *
 * @example
 * ```ts
 * // Manual mode
 * const mppx = Mppx.create({
 *   methods: [tempo({ account })],
 * })
 *
 * const credential = await mppx.createCredential(response, {
 *   action: 'voucher',
 *   channelId: '0x...',
 *   cumulativeAmount: '1',
 * })
 * ```
 */
export function session(parameters: session.Parameters = {}) {
  const { decimals = defaults.decimals } = parameters

  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  const maxDeposit =
    parameters.maxDeposit !== undefined ? parseUnits(parameters.maxDeposit, decimals) : undefined

  const escrowContractMap = new Map<string, Address>()
  const channels = new Map<string, SessionActions.ChannelEntry>()
  const channelIdToKey = new Map<string, string>()

  function notifyUpdate(entry: SessionActions.ChannelEntry) {
    parameters.onChannelUpdate?.(entry)
  }

  function channelKey(payee: Address, currency: Address, escrow: Address): string {
    return `${payee.toLowerCase()}:${currency.toLowerCase()}:${escrow.toLowerCase()}`
  }

  function resolveEscrowCached(
    challenge: { request: { methodDetails?: unknown } },
    chainId: number,
    channelId?: string,
  ): Address {
    if (channelId) {
      const cached = escrowContractMap.get(channelId)
      if (cached) return cached
    }
    return resolveEscrow(challenge, chainId, parameters.escrowContract)
  }

  function asSessionChallenge(challenge: Challenge.Challenge): SessionActions.SessionChallenge {
    return challenge as SessionActions.SessionChallenge
  }

  async function autoManageCredential(
    challenge: Challenge.Challenge,
    account: viem_Account,
    context?: SessionContext,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string; feePayer?: boolean }
      | undefined
    const chainId = md?.chainId ?? 0
    const client = await getClient({ chainId })
    const escrowContract = resolveEscrowCached(challenge, chainId)
    const payee = challenge.request.recipient as Address
    const currency = challenge.request.currency as Address
    const amount = BigInt(challenge.request.amount as string)

    const suggestedDepositRaw = (challenge.request as { suggestedDeposit?: string })
      .suggestedDeposit
    const suggestedDeposit = suggestedDepositRaw ? BigInt(suggestedDepositRaw) : undefined

    const deposit = (() => {
      if (context?.depositRaw) return BigInt(context.depositRaw)
      if (parameters.deposit !== undefined) return parseUnits(parameters.deposit, decimals)
      if (suggestedDeposit !== undefined && maxDeposit !== undefined)
        return suggestedDeposit < maxDeposit ? suggestedDeposit : maxDeposit
      if (maxDeposit !== undefined) return maxDeposit
      if (suggestedDeposit !== undefined) return suggestedDeposit
      throw new Error(
        'No deposit amount available. Set `deposit`, `maxDeposit`, or ensure the server challenge includes `suggestedDeposit`.',
      )
    })()

    const voucherSigner = parameters.voucherSigner ?? account

    const key = channelKey(payee, currency, escrowContract)
    let entry = channels.get(key)

    if (!entry) {
      const suggestedChannelId = (context?.channelId ?? md?.channelId) as Hex.Hex | undefined
      if (suggestedChannelId) {
        const recovered = await tryRecoverChannel(
          client,
          escrowContract,
          suggestedChannelId,
          chainId,
        )
        if (recovered) {
          const contextCumulative = context?.cumulativeAmountRaw
            ? BigInt(context.cumulativeAmountRaw)
            : context?.cumulativeAmount
              ? parseUnits(context.cumulativeAmount, decimals)
              : undefined
          if (contextCumulative !== undefined) recovered.cumulativeAmount = contextCumulative
          channels.set(key, recovered)
          channelIdToKey.set(recovered.channelId, key)
          escrowContractMap.set(recovered.channelId, escrowContract)
          entry = recovered
          notifyUpdate(entry)
        } else if (context?.channelId) {
          throw new Error(
            `Channel ${context.channelId} cannot be reused (closed or not found on-chain).`,
          )
        }
      }
    }

    if (entry?.opened) {
      entry.cumulativeAmount += amount
      const credential = await SessionActions.voucher.createCredential(client, {
        challenge: asSessionChallenge(challenge),
        channelId: entry.channelId,
        cumulativeAmount: entry.cumulativeAmount,
        escrowContract,
        signer: account,
        voucherSigner,
      })
      notifyUpdate(entry)
      return credential
    } else {
      const filled = await SessionActions.open.fill(client, {
        authorizedSigner: getAccountSignerAddress(voucherSigner),
        challenge: asSessionChallenge(challenge),
        deposit,
        escrowContract,
        payer: account.address,
      })
      const credential = await SessionActions.open.createCredential(client, {
        filled,
        signer: account,
        voucherSigner,
      })
      const entry = {
        channelId: filled.channelId,
        salt: filled.salt,
        cumulativeAmount: amount,
        escrowContract,
        chainId,
        opened: true,
      } satisfies SessionActions.ChannelEntry
      channels.set(key, entry)
      channelIdToKey.set(entry.channelId, key)
      escrowContractMap.set(entry.channelId, escrowContract)
      notifyUpdate(entry)
      return credential
    }
  }

  async function manualCredential(
    challenge: Challenge.Challenge,
    account: viem_Account,
    context: SessionContext,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string }
      | undefined
    const chainId = md?.chainId ?? 0
    const client = await getClient({ chainId })

    const action = context.action!
    const { channelId: channelIdRaw, transaction } = context
    const voucherSigner = parameters.voucherSigner ?? account
    const channelId = channelIdRaw as Hex.Hex
    const cumulativeAmount = context.cumulativeAmountRaw
      ? BigInt(context.cumulativeAmountRaw)
      : context.cumulativeAmount
        ? parseUnits(context.cumulativeAmount, decimals)
        : undefined
    const resolvedAdditionalDeposit = context.additionalDepositRaw
      ? BigInt(context.additionalDepositRaw)
      : context.additionalDeposit
        ? parseUnits(context.additionalDeposit, decimals)
        : undefined

    const escrowContract = resolveEscrowCached(challenge, chainId, channelId)
    escrowContractMap.set(channelId, escrowContract)

    switch (action) {
      case 'open': {
        if (!transaction) throw new Error('transaction required for open action')
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for open action')
        return SessionActions.open.createCredential(client, {
          challenge: asSessionChallenge(challenge),
          channelId,
          cumulativeAmount,
          escrowContract,
          signer: account,
          authorizedSigner: getAccountSignerAddress(voucherSigner),
          transaction: transaction as Hex.Hex,
          voucherSigner,
        })
      }

      case 'topUp':
        if (!transaction) throw new Error('transaction required for topUp action')
        if (resolvedAdditionalDeposit === undefined)
          throw new Error('additionalDeposit required for topUp action')
        return SessionActions.topUp.createCredential(client, {
          additionalDeposit: resolvedAdditionalDeposit,
          challenge: asSessionChallenge(challenge),
          channelId,
          escrowContract,
          signer: account,
          transaction: transaction as Hex.Hex,
        })

      case 'voucher': {
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for voucher action')
        const credential = await SessionActions.voucher.createCredential(client, {
          challenge: asSessionChallenge(challenge),
          channelId,
          cumulativeAmount,
          escrowContract,
          signer: account,
          voucherSigner,
        })
        const key = channelIdToKey.get(channelId)
        if (key) {
          const entry = channels.get(key)
          if (entry) {
            entry.cumulativeAmount =
              entry.cumulativeAmount > cumulativeAmount ? entry.cumulativeAmount : cumulativeAmount
            notifyUpdate(entry)
          }
        }
        return credential
      }

      case 'close': {
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for close action')
        const credential = await SessionActions.close.createCredential(client, {
          challenge: asSessionChallenge(challenge),
          channelId,
          cumulativeAmount,
          escrowContract,
          signer: account,
          voucherSigner,
        })
        const closeKey = channelIdToKey.get(channelId)
        if (closeKey) {
          const entry = channels.get(closeKey)
          if (entry) {
            entry.opened = false
            entry.cumulativeAmount =
              entry.cumulativeAmount > cumulativeAmount ? entry.cumulativeAmount : cumulativeAmount
            notifyUpdate(entry)
          }
        }
        return credential
      }
    }
  }

  return Method.toClient(Methods.session, {
    context: sessionContextSchema,

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId ?? 0
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      if (!context?.action && (parameters.deposit !== undefined || maxDeposit !== undefined))
        return autoManageCredential(challenge, account, context)

      if (context?.action) return manualCredential(challenge, account, context)

      throw new Error(
        'No `action` in context and no `deposit` or `maxDeposit` configured. Either provide context with action/channelId/cumulativeAmount, or configure `deposit`/`maxDeposit` for auto-management.',
      )
    },
  })
}

export declare namespace session {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Account that signs voucher digests. Defaults to `account`; access-key accounts sign raw vouchers as their access-key address. */
      voucherSigner?: viem_Account | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** Initial deposit amount in human-readable units (e.g. "10" for 10 tokens). When set, the method handles the full channel lifecycle (open, voucher, cumulative tracking) automatically. */
      deposit?: string | undefined
      /** Escrow contract address override. Derived from challenge or defaults if not provided. */
      escrowContract?: Address | undefined
      /** Maximum deposit in human-readable units (e.g. "10"). Caps the server's `suggestedDeposit`. Enables auto-management like `deposit`. */
      maxDeposit?: string | undefined
      /** Called whenever channel state changes (open, voucher, close, recovery). */
      onChannelUpdate?: ((entry: SessionActions.ChannelEntry) => void) | undefined
    }
}
