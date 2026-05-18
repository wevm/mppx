import type * as Hex from 'ox/Hex'
import type { Address, Call, Client as viem_Client } from 'viem'
import {
  prepareTransactionRequest,
  sendCallsSync,
  signTypedData,
  signTransaction,
} from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'

import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import type { MaybePromise } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as AutoSwap from '../internal/auto-swap.js'
import * as Charge_internal from '../internal/charge.js'
import * as defaults from '../internal/defaults.js'
import * as Proof from '../internal/proof.js'
import * as Methods from '../Methods.js'

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
export function charge<
  const mode extends Methods.ChargeMode | undefined = Methods.ChargeMode | undefined,
>(parameters: charge.Parameters<mode> = {} as charge.Parameters<mode>) {
  const { clientId } = parameters
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.charge, {
    context: z.object({
      account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
      autoSwap: z.optional(z.custom<charge.AutoSwap>()),
      mode: z.optional(z.enum(Methods.chargeModes)),
    }),

    async createCredential({ challenge, context }) {
      const challengeChainId = challenge.request.methodDetails?.chainId
      const client = await getClient({ chainId: challengeChainId })
      const chainId = challengeChainId ?? client.chain?.id
      if (chainId === undefined)
        throw new Error('No `chainId` provided. Pass a chain ID in the challenge or client.')

      const account = getAccount(client, context)

      const { request } = challenge
      const { amount, methodDetails } = request

      // Zero-amount: sign EIP-712 typed data instead of creating a transaction.
      if (BigInt(amount) === 0n) {
        const signature = await signTypedData(client, {
          account,
          domain: Proof.domain(chainId),
          types: Proof.types,
          primaryType: 'Proof',
          message: Proof.message(challenge.id, challenge.realm),
        })
        return Credential.serialize({
          challenge,
          payload: { signature, type: 'proof' },
          source: Proof.proofSource({ address: account.address, chainId }),
        })
      }

      const currency = request.currency as Address
      if (parameters.expectedRecipients) {
        const allowed = new Set(parameters.expectedRecipients.map((a) => a.toLowerCase()))
        const splits = methodDetails?.splits as readonly { recipient: string }[] | undefined
        if (splits) {
          for (const split of splits) {
            if (!allowed.has(split.recipient.toLowerCase()))
              throw new Error(`Unexpected split recipient: ${split.recipient}`)
          }
        }
      }
      const supportedModes = (methodDetails?.supportedModes as
        | readonly Methods.ChargeMode[]
        | undefined) ?? ['pull', 'push']
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

      const memo = methodDetails?.memo
        ? (methodDetails.memo as Hex.Hex)
        : Attribution.encode({ challengeId: challenge.id, clientId, serverId: challenge.realm })
      const transfers = Charge_internal.getTransfers({
        amount,
        methodDetails: {
          ...methodDetails,
          memo,
        },
        recipient: request.recipient as Address,
      })
      const transferCalls = transfers.map((transfer) =>
        Actions.token.transfer.call({
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

      const swapCalls = autoSwap
        ? await AutoSwap.findCalls(client, {
            account: account.address,
            amountOut: BigInt(amount),
            tokenOut: currency,
            tokenIn: autoSwap.tokenIn,
            slippage: autoSwap.slippage,
          })
        : undefined

      const calls = [...(swapCalls ?? []), ...transferCalls]

      const validBefore = (() => {
        const defaultExpiry = Math.floor(Date.now() / 1000) + 25
        if (!challenge.expires) return defaultExpiry
        const challengeExpiry = Math.floor(new Date(challenge.expires).getTime() / 1000)
        return Math.min(defaultExpiry, challengeExpiry)
      })()

      const executionRequest = {
        calls: calls as readonly Call[],
        ...(methodDetails?.feePayer && { feePayer: true as const }),
        nonceKey: 'expiring',
        validBefore,
      } satisfies charge.FillPayloadRequest

      const result = parameters.fillPayload
        ? await (parameters.fillPayload as unknown as charge.FillPayload)({
            account,
            challenge,
            chainId,
            client,
            mode,
            request: executionRequest,
          })
        : await fillPayload_default({
            account,
            challenge,
            chainId,
            client,
            mode,
            request: executionRequest,
          })

      if (mode === 'push') {
        if (result.type !== 'hash')
          throw new Error('fillPayload must return a hash result for push mode.')
        return Credential.serialize({
          challenge,
          payload: { hash: result.hash, type: 'hash' },
          source: Proof.proofSource({ address: account.address, chainId }),
        })
      }

      if (result.type !== 'transaction')
        throw new Error('fillPayload must return a transaction result for pull mode.')

      return Credential.serialize({
        challenge,
        payload: { signature: result.signature, type: 'transaction' },
        source: Proof.proofSource({ address: account.address, chainId }),
      })
    },
  })
}

async function fillPayload_default(
  parameters: charge.FillPayloadParameters,
): Promise<charge.FillPayloadResult> {
  const { account, client, mode, request } = parameters

  if (mode === 'push') {
    const { receipts } = await sendCallsSync(client, {
      account,
      calls: request.calls as never,
      experimental_fallback: true,
    })
    const hash = receipts?.[0]?.transactionHash
    if (!hash) throw new Error('No transaction receipt returned.')
    return { hash, type: 'hash' }
  }

  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: request.calls,
    ...(request.feePayer && { feePayer: request.feePayer }),
    nonceKey: request.nonceKey,
    validBefore: request.validBefore,
  } as never)
  // FIXME: figure out gas estimation issue for fee payer tx
  prepared.gas = prepared.gas! + 5_000n
  const signature = await signTransaction(client, prepared as never)

  return { signature, type: 'transaction' }
}

export declare namespace charge {
  type AutoSwap = AutoSwap.resolve.Value

  type FillPayloadResultMap = {
    pull: { signature: Hex.Hex; type: 'transaction' }
    push: { hash: Hex.Hex; type: 'hash' }
  }

  type FillPayloadResult<mode extends Methods.ChargeMode = Methods.ChargeMode> =
    FillPayloadResultMap[mode]

  type FillPayloadRequest = {
    /** Finalized payment calls MPPX would otherwise pass to viem. */
    calls: readonly Call[]
    /** Whether the transaction should request Tempo fee-payer sponsorship. */
    feePayer?: true | undefined
    /** Expiring nonce key passed to Tempo transaction preparation. */
    nonceKey?: 'expiring' | undefined
    /** Expiration timestamp, in whole Unix seconds, for the expiring nonce. */
    validBefore?: number | undefined
  }

  type FillPayloadParameters<mode extends Methods.ChargeMode = Methods.ChargeMode> = {
    /** Payer identity selected by MPPX. Custom hooks must produce a payload for this address. */
    account: Account.Account
    /** Original payment challenge. */
    challenge: Challenge.Challenge<
      z.output<typeof Methods.charge.schema.request>,
      typeof Methods.charge.intent,
      typeof Methods.charge.name
    >
    /** Chain ID used for the payment transaction. */
    chainId: number
    /** Viem client resolved by `getClient`. */
    client: viem_Client
    /** Final selected charge mode. */
    mode: mode
    /** Finalized transaction request fields MPPX would otherwise execute. */
    request: FillPayloadRequest
  }

  type ResolveFillPayloadMode<mode extends Methods.ChargeMode | undefined> =
    mode extends Methods.ChargeMode ? mode : Methods.ChargeMode

  type FillPayload<mode extends Methods.ChargeMode = Methods.ChargeMode> = (
    parameters: FillPayloadParameters<mode>,
  ) => MaybePromise<FillPayloadResult<mode>>

  type Parameters<mode extends Methods.ChargeMode | undefined = Methods.ChargeMode | undefined> = {
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
     * Fills the Tempo charge credential payload from the finalized payment calls.
     *
     * MPPX still validates the challenge, selects the charge mode, builds the
     * transfer and auto-swap calls, and serializes the credential. The hook only
     * replaces the final signing or submission step and must produce a payload
     * for `account.address`.
     */
    fillPayload?: FillPayload<ResolveFillPayloadMode<mode>> | undefined
    /**
     * Allowlist of expected split recipient addresses. When set, the client
     * rejects any challenge whose split recipients are not in this list.
     */
    expectedRecipients?: readonly Address[] | undefined
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
    mode?: mode | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
