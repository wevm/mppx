import { type Address, type Hex, parseUnits, type Account as viem_Account } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import type * as Challenge from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Method from '../../../Method.js'
import * as Account from '../../../viem/Account.js'
import * as Client from '../../../viem/Client.js'
import * as z from '../../../zod.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import type { SessionCredentialPayload, Uint96 } from '../Types.js'
import { uint96 } from '../Types.js'
import {
  createOpen,
  createOpenCredential,
  createTopUp,
  createTopUpCredential,
  createVoucherCredential,
  type OpenResult,
} from './ChannelOps.js'

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
  challenge: { request: { methodDetails?: unknown } },
  escrowOverride?: Address | undefined,
): Address {
  const challengeEscrow = (challenge.request.methodDetails as { escrow?: string } | undefined)
    ?.escrow as Address | undefined
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

/** Creates a client-side TIP-1034 precompile session payment method. */
export function session(parameters: session.Parameters = {}) {
  const { decimals = defaults.decimals } = parameters

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
    const methodDetails = challenge.request.methodDetails as { chainId?: number } | undefined
    const chainId = methodDetails?.chainId ?? 0
    const client = await getClient({ chainId })
    const payee = challenge.request.recipient as Address
    const token = challenge.request.currency as Address
    const escrow = resolveEscrow(challenge, parameters.escrow)
    const amount = uint96(BigInt(challenge.request.amount as string))
    const key = channelKey(payee, token, escrow)
    const existing = channels.get(key)

    let payload: SessionCredentialPayload
    if (existing?.opened) {
      const cumulativeAmount = uint96(existing.cumulativeAmount + amount)
      payload = await createVoucherCredential(client, account, {
        chainId,
        cumulativeAmount,
        descriptor: existing.descriptor,
        escrow,
      })
      existing.cumulativeAmount = cumulativeAmount
      notifyUpdate(existing)
    } else {
      const suggestedDepositRaw = (challenge.request as { suggestedDeposit?: string })
        .suggestedDeposit
      const deposit = uint96(
        context?.depositRaw
          ? BigInt(context.depositRaw)
          : parameters.deposit !== undefined
            ? parseUnits(parameters.deposit, decimals)
            : suggestedDepositRaw !== undefined
              ? BigInt(suggestedDepositRaw)
              : BigInt(challenge.request.amount as string),
      )
      const open = await createOpen(client, account, {
        authorizedSigner: parameters.authorizedSigner,
        chainId,
        deposit,
        escrow,
        initialAmount: amount,
        operator: parameters.operator,
        payee,
        token,
      })
      const entry: ChannelEntry = {
        channelId: open.channelId,
        cumulativeAmount: amount,
        descriptor: open.descriptor,
        escrow,
        chainId,
        opened: true,
      }
      channels.set(key, entry)
      channelIdToKey.set(open.channelId, key)
      payload = createOpenCredential(open, amount)
      notifyUpdate(entry)
    }

    return serializeCredential(challenge, payload, chainId, account)
  }

  async function manualCredential(
    challenge: Challenge.Challenge,
    account: viem_Account,
    context: SessionContext,
  ): Promise<string> {
    const methodDetails = challenge.request.methodDetails as { chainId?: number } | undefined
    const chainId = methodDetails?.chainId ?? 0
    const client = await getClient({ chainId })
    const escrow = resolveEscrow(challenge, parameters.escrow)
    const action = context.action!
    const descriptor = context.descriptor
    if (!descriptor) throw new Error('descriptor required for precompile session action')
    const channelId = Channel.computeId(descriptor, { chainId, escrow })

    let payload: SessionCredentialPayload
    switch (action) {
      case 'open': {
        if (!context.transaction) throw new Error('transaction required for open action')
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for open action')
        payload = createOpenCredential(
          {
            channelId,
            descriptor,
            transaction: context.transaction as `0x${string}`,
            voucherSignature: (
              await createVoucherCredential(client, account, {
                chainId,
                cumulativeAmount,
                descriptor,
                escrow,
              })
            ).signature,
          } satisfies OpenResult,
          cumulativeAmount,
        )
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
          payload = createTopUpCredential(
            await createTopUp(client, account, { additionalDeposit, chainId, descriptor, escrow }),
            additionalDeposit,
          )
        }
        break
      }
      case 'voucher': {
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for voucher action')
        payload = await createVoucherCredential(client, account, {
          chainId,
          cumulativeAmount,
          descriptor,
          escrow,
        })
        break
      }
      case 'close': {
        const cumulativeAmount = parseContextAmount(context, decimals)
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for close action')
        const voucher = await createVoucherCredential(client, account, {
          chainId,
          cumulativeAmount,
          descriptor,
          escrow,
        })
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
      const chainId = challenge.request.methodDetails?.chainId ?? 0
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      if (!context?.action) return autoManageCredential(challenge, account, context)
      return manualCredential(challenge, account, context)
    },
  })
}

export declare namespace session {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers on behalf of the payer. */
      authorizedSigner?: Address | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** Initial deposit amount in human-readable units. */
      deposit?: string | undefined
      /** TIP-1034 precompile address override. */
      escrow?: Address | undefined
      /** Address authorized to operate the precompile channel on behalf of the payee. */
      operator?: Address | undefined
      /** Called whenever channel state changes. */
      onChannelUpdate?: ((entry: ChannelEntry) => void) | undefined
    }
}
