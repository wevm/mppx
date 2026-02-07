import {
  type Account,
  type Address,
  type Client,
  createClient,
  encodeFunctionData,
  type Hex,
  http,
  toHex,
} from 'viem'
import { prepareTransactionRequest, readContract, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import type { OneOf } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as z from '../../zod.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'
import { escrowAbi, getOnChainChannel } from '../stream/Chain.js'
import type { StreamCredentialPayload } from '../stream/Types.js'
import { signVoucher } from '../stream/Voucher.js'

// ---------------------------------------------------------------------------
// Context schema — accepted by both auto and manual modes.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ChannelEntry = {
  channelId: Hex
  salt: Hex
  cumulativeAmount: bigint
  opened: boolean
}

// ---------------------------------------------------------------------------
// ABIs (minimal)
// ---------------------------------------------------------------------------

const erc20ApproveAbi = [
  {
    type: 'function' as const,
    name: 'approve' as const,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable' as const,
  },
] as const

// ---------------------------------------------------------------------------
// stream() — main entry point
// ---------------------------------------------------------------------------

/**
 * Creates a stream payment client that auto-manages channel lifecycle.
 *
 * **Two modes:**
 *
 * 1. **Auto mode** (set `deposit`) — the client handles channel open, voucher
 *    signing, and cumulative tracking. Just call `fetch(url)`.
 *
 * 2. **Manual mode** (pass `context.action`) — full control over each step.
 *    You provide channelId, cumulativeAmount, and transaction yourself.
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
  const rpcUrl = parameters.rpcUrl ?? defaults.rpcUrl

  // -- Shared helpers -------------------------------------------------------

  function getClient(chainId: number): Client {
    if (parameters.client) return parameters.client(chainId)

    const url = rpcUrl[chainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${chainId}).`)

    return createClient({
      chain: { ...tempo_chain, id: chainId },
      transport: http(url),
    })
  }

  /** channelId → escrowContract cache (populated on open/recover). */
  const escrowContractMap = new Map<string, Address>()

  /** (payee:currency:escrow) → channel state (in-memory, not persisted). */
  const channels = new Map<string, ChannelEntry>()

  function channelKey(payee: Address, currency: Address, escrow: Address): string {
    return `${payee.toLowerCase()}:${currency.toLowerCase()}:${escrow.toLowerCase()}`
  }

  function randomSalt(): Hex {
    const bytes = new Uint8Array(32)
    globalThis.crypto.getRandomValues(bytes)
    return toHex(bytes, { size: 32 })
  }

  /**
   * Resolve escrow contract address from (in order):
   *   1. Cache (if we've seen this channelId before)
   *   2. Server challenge methodDetails
   *   3. Parameters
   */
  function resolveEscrow(
    challenge: { request: { methodDetails?: unknown } },
    channelId?: string,
  ): Address {
    if (channelId) {
      const cached = escrowContractMap.get(channelId)
      if (cached) return cached
    }
    const challengeEscrow = (challenge.request.methodDetails as { escrowContract?: string })
      ?.escrowContract as Address | undefined
    const escrow = challengeEscrow ?? parameters.escrowContract
    if (!escrow)
      throw new Error(
        'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
      )
    return escrow
  }

  function resolveChainId(md: { chainId?: number } | undefined): number {
    const chainId = md?.chainId ?? Number(Object.keys(rpcUrl)[0])
    if (Number.isNaN(chainId))
      throw new Error(
        'No `chainId` available. Provide it in challenge methodDetails or configure `rpcUrl`.',
      )
    return chainId
  }

  /** Sign a voucher and build the credential payload. */
  async function voucherPayload(
    client: Client,
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

  /** Serialize a credential payload into a full Authorization header value. */
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

  // -- Auto mode ------------------------------------------------------------
  //
  // When `parameters.deposit` is set, the client manages the full lifecycle:
  //
  //   1. First request → open a channel on-chain + sign initial voucher
  //   2. Subsequent requests → increment cumulative amount + sign new voucher
  //
  // If the server challenge includes a channelId hint, we try to recover
  // an existing on-chain channel before opening a new one.

  async function autoManageCredential(
    challenge: Challenge.Challenge,
    account: Account,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string }
      | undefined
    const chainId = resolveChainId(md)
    const client = getClient(chainId)
    const escrowContract = resolveEscrow(challenge)
    const payee = challenge.request.recipient as Address
    const currency = challenge.request.currency as Address
    const amount = BigInt(challenge.request.amount as string)
    const deposit = parameters.deposit!

    const key = channelKey(payee, currency, escrowContract)
    let entry = channels.get(key)

    // Try to recover an existing on-chain channel if the server hinted one.
    if (!entry) {
      const suggestedChannelId = md?.channelId as Hex | undefined
      if (suggestedChannelId) {
        const url = rpcUrl[chainId as keyof typeof rpcUrl]
        if (url) entry = await tryRecoverChannel(url, escrowContract, suggestedChannelId, key)
      }
    }

    let payload: StreamCredentialPayload

    if (entry?.opened) {
      // Channel already open — sign a new voucher with incremented amount.
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
      // No channel — open one with approve+open batched in a single tx.
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

  /** Build and sign an approve+open transaction, returning the open payload + channel entry. */
  async function openChannel(
    client: Client,
    account: Account,
    escrowContract: Address,
    payee: Address,
    currency: Address,
    deposit: bigint,
    initialAmount: bigint,
    chainId: number,
  ): Promise<{ entry: ChannelEntry; payload: StreamCredentialPayload }> {
    const salt = randomSalt()

    const channelId = await readContract(client, {
      address: escrowContract,
      abi: escrowAbi,
      functionName: 'computeChannelId',
      args: [account.address, payee, currency, deposit, salt, account.address],
    })

    const approveData = encodeFunctionData({
      abi: erc20ApproveAbi,
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

  /**
   * Try to recover an existing on-chain channel by reading its state.
   * Returns a ChannelEntry if the channel is open and not finalized.
   */
  async function tryRecoverChannel(
    chainRpcUrl: string,
    escrowContract: Address,
    channelId: Hex,
    key: string,
  ): Promise<ChannelEntry | undefined> {
    try {
      const onChain = await getOnChainChannel(chainRpcUrl, escrowContract, channelId)

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
    } catch {
      // Channel doesn't exist on-chain or query failed
    }

    return undefined
  }

  // -- Manual mode ----------------------------------------------------------
  //
  // When the caller provides `context.action`, they control the full flow.
  // The client just signs vouchers and serializes the credential — no
  // automatic channel management.

  async function manualCredential(
    challenge: Challenge.Challenge,
    account: Account,
    context: StreamContext,
  ): Promise<string> {
    const md = challenge.request.methodDetails as
      | { chainId?: number; escrowContract?: string; channelId?: string }
      | undefined
    const chainId = resolveChainId(md)
    const client = getClient(chainId)

    const action = context.action!
    const {
      channelId: channelIdRaw,
      cumulativeAmount,
      transaction,
      authorizedSigner,
      additionalDeposit,
    } = context
    const channelId = channelIdRaw as Hex

    const escrowContract = resolveEscrow(challenge, channelId)
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

  // -- createCredential (router) --------------------------------------------
  //
  //   context.action provided?
  //     YES → manual mode
  //     NO  → deposit configured? → auto mode
  //                               → error

  return MethodIntent.toClient(Intents.stream, {
    context: streamContextSchema,

    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      // Auto mode: deposit is configured and no explicit action was provided.
      if (!context?.action && parameters.deposit !== undefined) {
        return autoManageCredential(challenge, account)
      }

      // Manual mode: caller specified an explicit action.
      if (context?.action) {
        return manualCredential(challenge, account, context)
      }

      throw new Error(
        'No `action` in context and no `deposit` configured. Either provide context with action/channelId/cumulativeAmount, or configure `deposit` for auto-management.',
      )
    },
  })
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export declare namespace stream {
  type Parameters = {
    /** Account to sign vouchers with. */
    account?: Account | undefined
    /** Escrow contract address override. Derived from challenge if not provided. */
    escrowContract?: Address | undefined
    /** Initial deposit amount for auto-managed channels. When set, the method handles the full channel lifecycle (open, voucher, cumulative tracking) automatically. */
    deposit?: bigint | undefined
  } & OneOf<
    | {
        /** Function that returns a client for the given chain ID. */
        client?: ((chainId: number) => Client) | undefined
      }
    | {
        /** RPC URLs keyed by chain ID. */
        rpcUrl?: ({ [chainId: number]: string } & object) | undefined
      }
  >
}
