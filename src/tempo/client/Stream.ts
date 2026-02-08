import {
  type Account,
  type Address,
  encodeFunctionData,
  type Hex,
  toHex,
  type Client as viem_Client,
} from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis } from 'viem/tempo'
import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'
import { escrowAbi, getOnChainChannel } from '../stream/Chain.js'
import * as Channel from '../stream/Channel.js'
import type { StreamCredentialPayload } from '../stream/Types.js'
import { signVoucher } from '../stream/Voucher.js'

export const streamContextSchema = z.object({
  account: z.optional(z.custom<Account>()),
  action: z.optional(z.enum(['open', 'topUp', 'voucher', 'close'])),
  channelId: z.optional(z.string()),
  cumulativeAmount: z.optional(z.bigint()),
  transaction: z.optional(z.string()),
  authorizedSigner: z.optional(z.string()),
  additionalDeposit: z.optional(z.bigint()),
})

export type StreamContext = z.infer<typeof streamContextSchema>

type ChannelEntry = {
  channelId: Hex
  salt: Hex
  cumulativeAmount: bigint
  opened: boolean
}

/**
 * Creates a stream payment client.
 *
 * @example
 * ```ts
 * // Auto mode
 * import { Fetch, tempo } from 'mpay/client'
 *
 * const fetch = Fetch.from({
 *   methods: [
 *     tempo.stream({
 *       account: privateKeyToAccount('0x...'),
 *       deposit: 10_000_000n,
 *     }),
 *   ],
 * })
 *
 * const res = await fetch('/api/chat?prompt=hello')
 * ```
 *
 * @example
 * ```ts
 * // Manual mode
 * const mpay = Mpay.create({
 *   methods: [tempo.stream({ account })],
 * })
 *
 * const credential = await mpay.createCredential(response, {
 *   action: 'voucher',
 *   channelId: '0x...',
 *   cumulativeAmount: 1_000_000n,
 * })
 * ```
 */
export function stream(parameters: stream.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  const escrowContractMap = new Map<string, Address>()
  const channels = new Map<string, ChannelEntry>()

  function channelKey(payee: Address, currency: Address, escrow: Address): string {
    return `${payee.toLowerCase()}:${currency.toLowerCase()}:${escrow.toLowerCase()}`
  }

  function randomSalt(): Hex {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    return toHex(bytes, { size: 32 })
  }

  function resolveEscrow(
    challenge: { request: { methodDetails?: unknown } },
    chainId: number,
    channelId?: string,
  ): Address {
    if (channelId) {
      const cached = escrowContractMap.get(channelId)
      if (cached) return cached
    }
    const challengeEscrow = (challenge.request.methodDetails as { escrowContract?: string })
      ?.escrowContract as Address | undefined
    const escrow =
      challengeEscrow ??
      parameters.escrowContract ??
      ((defaults.escrowContract as Record<number, string>)[chainId] as Address | undefined)
    if (!escrow)
      throw new Error(
        'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
      )
    return escrow
  }

  async function voucherPayload(
    client: viem_Client,
    account: Account,
    channelId: Hex,
    cumulativeAmount: bigint,
    escrowContract: Address,
    chainId: number,
  ): Promise<StreamCredentialPayload> {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    return {
      action: 'voucher',
      channelId,
      cumulativeAmount: cumulativeAmount.toString(),
      signature,
    }
  }

  function serializeCredential(
    challenge: Challenge.Challenge,
    payload: StreamCredentialPayload,
    chainId: number,
    account: Account,
  ): string {
    return Credential.serialize({
      challenge,
      payload,
      source: `did:pkh:eip155:${chainId}:${account.address}`,
    })
  }

  async function autoManageCredential(
    challenge: Challenge.Challenge,
    account: Account,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string }
      | undefined
    const chainId = md?.chainId ?? 0
    const client = await getClient(chainId)
    const escrowContract = resolveEscrow(challenge, chainId)
    const payee = challenge.request.recipient as Address
    const currency = challenge.request.currency as Address
    const amount = BigInt(challenge.request.amount as string)
    const deposit = parameters.deposit!

    const key = channelKey(payee, currency, escrowContract)
    let entry = channels.get(key)

    if (!entry) {
      const suggestedChannelId = md?.channelId as Hex | undefined
      if (suggestedChannelId)
        entry = await tryRecoverChannel(client, escrowContract, suggestedChannelId, key)
    }

    let payload: StreamCredentialPayload

    if (entry?.opened) {
      entry.cumulativeAmount += amount
      payload = await voucherPayload(
        client,
        account,
        entry.channelId,
        entry.cumulativeAmount,
        escrowContract,
        chainId,
      )
    } else {
      const result = await openChannel(
        client,
        account,
        escrowContract,
        payee,
        currency,
        deposit,
        amount,
        chainId,
      )
      channels.set(key, result.entry)
      escrowContractMap.set(result.entry.channelId, escrowContract)
      payload = result.payload
    }

    return serializeCredential(challenge, payload, chainId, account)
  }

  async function openChannel(
    client: viem_Client,
    account: Account,
    escrowContract: Address,
    payee: Address,
    currency: Address,
    deposit: bigint,
    initialAmount: bigint,
    chainId: number,
  ): Promise<{ entry: ChannelEntry; payload: StreamCredentialPayload }> {
    const salt = randomSalt()

    const channelId = Channel.computeId({
      authorizedSigner: account.address,
      chainId,
      deposit,
      escrowContract,
      payee,
      payer: account.address,
      salt,
      token: currency,
    })

    const approveData = encodeFunctionData({
      abi: Abis.tip20,
      functionName: 'approve',
      args: [escrowContract, deposit],
    })
    const openData = encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [payee, currency, deposit, salt, account.address],
    })

    const prepared = await prepareTransactionRequest(client, {
      account,
      calls: [
        { to: currency, data: approveData },
        { to: escrowContract, data: openData },
      ],
    } as never)
    prepared.gas = prepared.gas! + 5_000n
    const transaction = (await signTransaction(client, prepared as never)) as Hex

    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount: initialAmount },
      escrowContract,
      chainId,
    )

    return {
      entry: { channelId, salt, cumulativeAmount: initialAmount, opened: true },
      payload: {
        action: 'open',
        type: 'transaction',
        channelId,
        transaction,
        authorizedSigner: account.address,
        cumulativeAmount: initialAmount.toString(),
        signature,
      },
    }
  }

  async function tryRecoverChannel(
    client: viem_Client,
    escrowContract: Address,
    channelId: Hex,
    key: string,
  ): Promise<ChannelEntry | undefined> {
    try {
      const onChain = await getOnChainChannel(client, escrowContract, channelId)

      if (onChain.deposit > 0n && !onChain.finalized) {
        const entry: ChannelEntry = {
          channelId,
          salt: '0x' as Hex,
          cumulativeAmount: onChain.settled,
          opened: true,
        }
        channels.set(key, entry)
        escrowContractMap.set(channelId, escrowContract)
        return entry
      }
    } catch {}

    return undefined
  }

  async function manualCredential(
    challenge: Challenge.Challenge,
    account: Account,
    context: StreamContext,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string }
      | undefined
    const chainId = md?.chainId ?? 0
    const client = await getClient(chainId)

    const action = context.action!
    const {
      channelId: channelIdRaw,
      cumulativeAmount,
      transaction,
      authorizedSigner,
      additionalDeposit,
    } = context
    const channelId = channelIdRaw as Hex

    const escrowContract = resolveEscrow(challenge, chainId, channelId)
    escrowContractMap.set(channelId, escrowContract)

    let payload: StreamCredentialPayload

    switch (action) {
      case 'open': {
        if (!transaction) throw new Error('transaction required for open action')
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for open action')
        const signature = await signVoucher(
          client,
          account,
          { channelId, cumulativeAmount },
          escrowContract,
          chainId,
        )
        payload = {
          action: 'open',
          type: 'transaction',
          channelId,
          transaction: transaction as Hex,
          authorizedSigner: (authorizedSigner as Address) ?? account.address,
          cumulativeAmount: cumulativeAmount.toString(),
          signature,
        }
        break
      }

      case 'topUp':
        if (!transaction) throw new Error('transaction required for topUp action')
        if (additionalDeposit === undefined)
          throw new Error('additionalDeposit required for topUp action')
        payload = {
          action: 'topUp',
          type: 'transaction',
          channelId,
          transaction: transaction as Hex,
          additionalDeposit: additionalDeposit.toString(),
        }
        break

      case 'voucher': {
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for voucher action')
        payload = await voucherPayload(
          client,
          account,
          channelId,
          cumulativeAmount,
          escrowContract,
          chainId,
        )
        break
      }

      case 'close': {
        if (cumulativeAmount === undefined)
          throw new Error('cumulativeAmount required for close action')
        const signature = await signVoucher(
          client,
          account,
          { channelId, cumulativeAmount },
          escrowContract,
          chainId,
        )
        payload = {
          action: 'close',
          channelId,
          cumulativeAmount: cumulativeAmount.toString(),
          signature,
        }
        break
      }
    }

    return serializeCredential(challenge, payload, chainId, account)
  }

  return MethodIntent.toClient(Intents.stream, {
    context: streamContextSchema,

    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      if (!context?.action && parameters.deposit !== undefined)
        return autoManageCredential(challenge, account)

      if (context?.action) return manualCredential(challenge, account, context)

      throw new Error(
        'No `action` in context and no `deposit` configured. Either provide context with action/channelId/cumulativeAmount, or configure `deposit` for auto-management.',
      )
    },
  })
}

export declare namespace stream {
  type Parameters = Client.getResolver.Parameters & {
    /** Account to sign vouchers with. Can be overridden per-call via context. */
    account?: Account | undefined
    /** Initial deposit amount for auto-managed channels. When set, the method handles the full channel lifecycle (open, voucher, cumulative tracking) automatically. */
    deposit?: bigint | undefined
    /** Escrow contract address override. Derived from challenge or defaults if not provided. */
    escrowContract?: Address | undefined
  }
}
