import { type Address, type Hex, parseUnits, type Account as viem_Account } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import type * as Challenge from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Method from '../../../Method.js'
import * as Account from '../../../viem/Account.js'
import * as Client from '../../../viem/Client.js'
import * as z from '../../../zod.js'
import { resolveChainId } from '../../client/ChannelOps.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import {
  createOpenPayload,
  createTopUpPayload,
  createVoucherPayload,
} from '../client/ChannelOps.js'
import { tip20ChannelEscrow } from '../Constants.js'
import type { SessionCredentialPayload, Uint96 } from '../Types.js'
import { uint96 } from '../Types.js'

export type ChannelEntry = {
  channelId: Hex
  cumulativeAmount: Uint96
  descriptor: Channel.ChannelDescriptor
  escrow: Address
  chainId: number
  opened: boolean
}

export const sessionContextSchema = z.object({
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
  action: z.optional(z.enum(['open', 'topUp', 'voucher', 'close'])),
  channelId: z.optional(z.string()),
  cumulativeAmount: z.optional(z.amount()),
  cumulativeAmountRaw: z.optional(z.string()),
  additionalDeposit: z.optional(z.amount()),
  additionalDepositRaw: z.optional(z.string()),
  depositRaw: z.optional(z.string()),
  transaction: z.optional(z.string()),
  descriptor: z.optional(z.custom<Channel.ChannelDescriptor>()),
})

export type SessionContext = z.infer<typeof sessionContextSchema>

function serializeCredential(
  challenge: Challenge.Challenge,
  payload: SessionCredentialPayload,
  chainId: number,
  account: viem_Account,
): string {
  return Credential.serialize({
    challenge,
    payload,
    source: `did:pkh:eip155:${chainId}:${account.address}`,
  })
}

function channelKey(payee: Address, token: Address, escrow: Address): string {
  return `${payee.toLowerCase()}:${token.toLowerCase()}:${escrow.toLowerCase()}`
}

function resolveEscrow(
  challenge: {
    request: {
      methodDetails?: { escrow?: string | undefined; escrowContract?: string | undefined }
    }
  },
  escrowOverride?: Address | undefined,
): Address {
  const methodDetails = challenge.request.methodDetails
  const challengeEscrow = (methodDetails?.escrowContract ?? methodDetails?.escrow) as
    | Address
    | undefined
  return escrowOverride ?? challengeEscrow ?? tip20ChannelEscrow
}

function parseAmount(value: string | undefined, decimals: number): bigint | undefined {
  return value === undefined ? undefined : parseUnits(value, decimals)
}

function parseContextAmount(context: SessionContext, decimals: number): Uint96 | undefined {
  const amount = context.cumulativeAmountRaw
    ? BigInt(context.cumulativeAmountRaw)
    : parseAmount(context.cumulativeAmount, decimals)
  return amount === undefined ? undefined : uint96(amount)
}

function parseContextAdditionalDeposit(
  context: SessionContext,
  decimals: number,
): Uint96 | undefined {
  const amount = context.additionalDepositRaw
    ? BigInt(context.additionalDepositRaw)
    : parseAmount(context.additionalDeposit, decimals)
  return amount === undefined ? undefined : uint96(amount)
}

function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Creates a client-side TIP20EscrowChannel precompile session payment method. */
export function session(parameters: session.Parameters = {}) {
  const { decimals = defaults.decimals } = parameters
  const maxDeposit =
    parameters.maxDeposit !== undefined ? parseUnits(parameters.maxDeposit, decimals) : undefined

  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  const channels = new Map<string, ChannelEntry>()
  const channelIdToKey = new Map<string, string>()

  function notifyUpdate(entry: ChannelEntry) {
    parameters.onChannelUpdate?.(entry)
  }

  async function autoManageCredential(
    challenge: Challenge.Challenge,
    account: viem_Account,
    context?: SessionContext,
  ): Promise<string> {
    const methodDetails = challenge.request.methodDetails as { feePayer?: boolean } | undefined
    const chainId = resolveChainId(challenge)
    const client = await getClient({ chainId })
    const payee = challenge.request.recipient as Address
    const token = challenge.request.currency as Address
    const escrow = resolveEscrow(challenge, parameters.escrow)
    const amount = uint96(BigInt(challenge.request.amount as string))
    const key = channelKey(payee, token, escrow)
    const existing = channels.get(key)

    let payload: SessionCredentialPayload
    if (!existing && context?.channelId && !context.descriptor)
      throw new Error('descriptor required to reuse precompile channel')
    if (!existing && context?.descriptor) {
      const channelId = Channel.computeId({ ...context.descriptor, chainId, escrow })
      if (context.channelId && context.channelId.toLowerCase() !== channelId.toLowerCase())
        throw new Error('context channelId does not match descriptor')
      if (!isSameAddress(context.descriptor.payee, payee))
        throw new Error('context descriptor payee does not match challenge')
      if (!isSameAddress(context.descriptor.token, token))
        throw new Error('context descriptor token does not match challenge')
      const state = await Chain.getChannelState(client, channelId, escrow)
      if (state.deposit === 0n)
        throw new Error(`Channel ${channelId} cannot be reused (closed or not found on-chain).`)
      if (state.closeRequestedAt !== 0)
        throw new Error(`Channel ${channelId} cannot be reused (pending close request).`)
      const cumulativeAmount =
        parseContextAmount(context, decimals) ?? uint96(state.settled + amount)
      payload = await createVoucherPayload(client, account, context.descriptor, cumulativeAmount, chainId)
      const entry: ChannelEntry = {
        channelId,
        cumulativeAmount,
        descriptor: context.descriptor,
        escrow,
        chainId,
        opened: true,
      }
      channels.set(key, entry)
      channelIdToKey.set(channelId, key)
      notifyUpdate(entry)
    } else if (existing?.opened) {
      const cumulativeAmount = uint96(existing.cumulativeAmount + amount)
      payload = await createVoucherPayload(client, account, existing.descriptor, cumulativeAmount, chainId)
      existing.cumulativeAmount = cumulativeAmount
      notifyUpdate(existing)
    } else {
      const suggestedDepositRaw = (challenge.request as { suggestedDeposit?: string })
        .suggestedDeposit
      const deposit = uint96(
        (() => {
          if (context?.depositRaw) return BigInt(context.depositRaw)
          if (parameters.deposit !== undefined) return parseUnits(parameters.deposit, decimals)
          const suggestedDeposit =
            suggestedDepositRaw !== undefined ? BigInt(suggestedDepositRaw) : undefined
          if (suggestedDeposit !== undefined && maxDeposit !== undefined)
            return suggestedDeposit < maxDeposit ? suggestedDeposit : maxDeposit
          if (maxDeposit !== undefined) return maxDeposit
          if (suggestedDeposit !== undefined) return suggestedDeposit
          throw new Error(
            'No deposit amount available. Set `deposit`, `maxDeposit`, or ensure the server challenge includes `suggestedDeposit`.',
          )
        })(),
      )
      payload = await createOpenPayload(client, account, {
        authorizedSigner: parameters.authorizedSigner,
        chainId,
        deposit,
        feePayer: methodDetails?.feePayer,
        initialAmount: amount,
        operator: parameters.operator,
        payee,
        token,
      })
      if (payload.action !== 'open') throw new Error('expected open payload')
      const entry: ChannelEntry = {
        channelId: payload.channelId,
        cumulativeAmount: amount,
        descriptor: payload.descriptor,
        escrow,
        chainId,
        opened: true,
      }
      channels.set(key, entry)
      channelIdToKey.set(payload.channelId, key)
      notifyUpdate(entry)
    }

    return serializeCredential(challenge, payload, chainId, account)
  }

  async function manualCredential(
    challenge: Challenge.Challenge,
    account: viem_Account,
    context: SessionContext,
  ): Promise<string> {
    const chainId = resolveChainId(challenge)
    const client = await getClient({ chainId })
    const escrow = resolveEscrow(challenge, parameters.escrow)
    const action = context.action!
    const descriptor = context.descriptor
    if (!descriptor) throw new Error('descriptor required for precompile session action')
    const channelId = Channel.computeId({ ...descriptor, chainId, escrow })

    let payload: SessionCredentialPayload
    switch (action) {
      case 'open': {
        if (!context.transaction) throw new Error('transaction required for open action')
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for open action')
        const voucher = await createVoucherPayload(client, account, descriptor, cumulativeAmount, chainId)
        if (voucher.action !== 'voucher') throw new Error('expected voucher payload')
        payload = {
          action: 'open',
          type: 'transaction',
          channelId,
          transaction: context.transaction as `0x${string}`,
          signature: voucher.signature,
          descriptor,
          cumulativeAmount: cumulativeAmount.toString(),
          authorizedSigner: descriptor.authorizedSigner,
        }
        break
      }
      case 'topUp': {
        const additionalDeposit = parseContextAdditionalDeposit(context, decimals)
        if (additionalDeposit === undefined)
          throw new Error('additionalDeposit required for topUp action')
        if (context.transaction) {
          payload = {
            action: 'topUp',
            type: 'transaction',
            channelId,
            transaction: context.transaction as `0x${string}`,
            descriptor,
            additionalDeposit: additionalDeposit.toString(),
          }
        } else {
          payload = await createTopUpPayload(
            client,
            account,
            descriptor,
            additionalDeposit,
            chainId,
            (challenge.request.methodDetails as { feePayer?: boolean } | undefined)?.feePayer,
          )
        }
        break
      }
      case 'voucher': {
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for voucher action')
        payload = await createVoucherPayload(client, account, descriptor, cumulativeAmount, chainId)
        break
      }
      case 'close': {
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for close action')
        const voucher = await createVoucherPayload(client, account, descriptor, cumulativeAmount, chainId)
        if (voucher.action !== 'voucher') throw new Error('expected voucher payload')
        payload = { ...voucher, action: 'close' }
        break
      }
    }

    const key = channelIdToKey.get(channelId)
    if (key) {
      const entry = channels.get(key)
      if (entry && 'cumulativeAmount' in payload) {
        const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
        entry.cumulativeAmount =
          entry.cumulativeAmount > cumulativeAmount ? entry.cumulativeAmount : cumulativeAmount
        if (payload.action === 'close') entry.opened = false
        notifyUpdate(entry)
      }
    }

    return serializeCredential(challenge, payload, chainId, account)
  }

  return Method.toClient(Methods.session, {
    context: sessionContextSchema,
    async createCredential({ challenge, context }) {
      const chainId = resolveChainId(challenge)
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      if (!context?.action && (parameters.deposit !== undefined || maxDeposit !== undefined))
        return autoManageCredential(challenge, account, context)

      if (!context?.action && (challenge.request as { suggestedDeposit?: string }).suggestedDeposit)
        return autoManageCredential(challenge, account, context)

      if (context?.action) return manualCredential(challenge, account, context)

      throw new Error(
        'No `action` in context and no `deposit` or `maxDeposit` configured. Either provide context with action/descriptor/cumulativeAmount, or configure `deposit`/`maxDeposit` for auto-management.',
      )
    },
  })
}

export declare namespace session {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers on behalf of the payer. Defaults to the account access key address when available, otherwise the account address. */
      authorizedSigner?: Address | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** Initial deposit amount in human-readable units. */
      deposit?: string | undefined
      /** Maximum deposit in human-readable units. Caps the server suggestedDeposit and enables auto-management. */
      maxDeposit?: string | undefined
      /** TIP20EscrowChannel precompile address override. */
      escrow?: Address | undefined
      /** Address authorized to operate the precompile channel on behalf of the payee. */
      operator?: Address | undefined
      /** Called whenever channel state changes. */
      onChannelUpdate?: ((entry: ChannelEntry) => void) | undefined
    }
}
