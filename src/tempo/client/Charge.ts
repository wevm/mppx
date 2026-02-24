import type * as Hex from 'ox/Hex'
import type { Client as ViemClient } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'
import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'

// ---------------------------------------------------------------------------
// Settlement resolution
// ---------------------------------------------------------------------------

/** Discriminated union for how the client will settle the payment. */
export type SettlementResolution =
  | { type: 'direct'; token: `0x${string}` }
  | { type: 'swap'; heldToken: `0x${string}`; targetToken: `0x${string}`; maxAmountIn: bigint }

/**
 * Resolves how the client will settle the payment by checking balances.
 *
 * 1. Checks if the client holds sufficient balance of the target `token`.
 * 2. If not, scans known USD tokens for one the client holds and uses a DEX
 *    quote to determine the swap cost.
 */
export async function resolveSettlement(options: {
  client: ViemClient
  account: { address: `0x${string}` }
  amount: bigint
  token: `0x${string}`
  knownUsdTokens?: readonly string[]
}): Promise<SettlementResolution> {
  const { client, account, amount, token } = options

  // 1. Direct: check if client holds the target token with sufficient balance
  const balance = await Actions.token.getBalance(client, {
    token,
    account: account.address,
  })
  if (balance >= amount) {
    return { type: 'direct', token }
  }

  // 2. Swap path: check known USD tokens for a balance to swap from
  const knownUsdTokens = options.knownUsdTokens ?? [defaults.tokens.usdc, defaults.tokens.pathUsd]
  for (const heldToken of knownUsdTokens) {
    // Skip the target token (already checked above)
    if (heldToken.toLowerCase() === token.toLowerCase()) continue
    const heldBalance = await Actions.token.getBalance(client, {
      token: heldToken as Hex.Hex,
      account: account.address,
    })
    if (heldBalance > 0n) {
      try {
        const quotedAmountIn = await Actions.dex.getBuyQuote(client, {
          tokenIn: heldToken as Hex.Hex,
          tokenOut: token,
          amountOut: amount,
        })
        if (heldBalance >= quotedAmountIn) {
          return {
            type: 'swap',
            heldToken: heldToken as `0x${string}`,
            targetToken: token,
            maxAmountIn: quotedAmountIn,
          }
        }
      } catch {}
    }
  }

  throw new Error(
    `No USD tokens available for settlement. Checked: ${[token, ...knownUsdTokens].join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// charge()
// ---------------------------------------------------------------------------

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
    }),

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      const { request } = challenge
      const { amount, currency, recipient, methodDetails } = request

      const memo = methodDetails?.memo
        ? (methodDetails.memo as Hex.Hex)
        : Attribution.encode({ serverId: challenge.realm, clientId })

      const signAndSerialize = async (calls: unknown[]) => {
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
      }

      const resolution = await resolveSettlement({
        client,
        account,
        amount: BigInt(amount),
        token: currency as `0x${string}`,
      })

      if (resolution.type === 'direct') {
        return signAndSerialize([
          Actions.token.transfer.call({
            amount: BigInt(amount),
            memo,
            to: recipient as Hex.Hex,
            token: resolution.token,
          }),
        ])
      }

      // Swap path: atomic swap + transfer via 7702 batch
      return signAndSerialize([
        Actions.dex.buy.call({
          tokenIn: resolution.heldToken,
          tokenOut: resolution.targetToken,
          amountOut: BigInt(amount),
          maxAmountIn: resolution.maxAmountIn,
        }),
        Actions.token.transfer.call({
          amount: BigInt(amount),
          memo,
          to: recipient as Hex.Hex,
          token: resolution.targetToken,
        }),
      ])
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Client identifier used to derive the client fingerprint in attribution memos. */
    clientId?: string | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
