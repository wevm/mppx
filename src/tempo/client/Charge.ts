import type * as Hex from 'ox/Hex'
import type { Address } from 'viem'
import { prepareTransactionRequest, sendCallsSync, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as AutoSwap from '../internal/auto-swap.js'
import * as defaults from '../internal/defaults.js'
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
export function charge(parameters: charge.Parameters = {}) {
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
      mode: z.optional(z.enum(['push', 'pull'])),
    }),

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      const mode =
        context?.mode ?? parameters.mode ?? (account.type === 'json-rpc' ? 'push' : 'pull')

      const { request } = challenge
      const { amount, methodDetails } = request
      const currency = request.currency as Address
      const recipient = request.recipient as Address

      const memo = methodDetails?.memo
        ? (methodDetails.memo as Hex.Hex)
        : Attribution.encode({ serverId: challenge.realm, clientId })

      const transferCall = Actions.token.transfer.call({
        amount: BigInt(amount),
        memo,
        to: recipient,
        token: currency,
      })

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

      const calls = [...(swapCalls ?? []), transferCall]

      if (mode === 'push') {
        const { receipts } = await sendCallsSync(client, {
          account,
          calls: calls as never,
          experimental_fallback: true,
        })
        const hash = receipts?.[0]?.transactionHash
        if (!hash) throw new Error('No transaction receipt returned.')
        return Credential.serialize({
          challenge,
          payload: { hash, type: 'hash' },
          source: `did:pkh:eip155:${chainId}:${account.address}`,
        })
      }

      const prepared = await prepareTransactionRequest(client, {
        account,
        calls,
        ...(methodDetails?.feePayer && { feePayer: true }),
        nonceKey: 'expiring',
      } as never)
      // FIXME: figure out gas estimation issue for fee payer tx
      prepared.gas = prepared.gas! + 5_000n
      const signature = await signTransaction(client, prepared as never)

      return Credential.serialize({
        challenge,
        payload: { signature, type: 'transaction' },
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}

export declare namespace charge {
  type AutoSwap = AutoSwap.resolve.Value

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
     * Controls how the charge transaction is submitted.
     *
     * - `'push'`: Client broadcasts the transaction and sends the tx hash to the server.
     * - `'pull'`: Client signs the transaction and sends the serialized tx to the server for broadcast.
     *
     * @default `'push'` for JSON-RPC accounts, `'pull'` for local accounts.
     */
    mode?: 'push' | 'pull' | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
