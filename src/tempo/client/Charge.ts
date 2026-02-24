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
import * as Currency from '../Currency.js'
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
 * Resolves which settlement token to use by checking client balances.
 *
 * 1. Scans `settlementCurrencies` for a token the client already holds with sufficient balance (like-for-like).
 * 2. If no direct match, finds any USD token the client holds and targets the first
 *    settlement currency for an atomic swap, using a DEX quote for `maxAmountIn`.
 */
export async function resolveSettlement(options: {
  client: ViemClient
  account: { address: `0x${string}` }
  amount: bigint
  settlementCurrencies: string[]
  knownUsdTokens?: readonly string[]
}): Promise<SettlementResolution> {
  const { client, account, amount, settlementCurrencies } = options

  // 1. Like-for-like: scan settlementCurrencies for a token the client holds with sufficient balance
  for (const token of settlementCurrencies) {
    const balance = await Actions.token.getBalance(client, {
      token: token as Hex.Hex,
      account: account.address,
    })
    if (balance >= amount) {
      return { type: 'direct', token: token as `0x${string}` }
    }
  }

  // 2. Swap path: check known USD tokens for a balance to swap from
  const targetToken = settlementCurrencies[0] as `0x${string}`
  const knownUsdTokens = options.knownUsdTokens ?? [defaults.tokens.usdc, defaults.tokens.pathUsd]
  for (const token of knownUsdTokens) {
    // Skip tokens already checked above
    if (settlementCurrencies.some((sc) => sc.toLowerCase() === token.toLowerCase())) continue
    const balance = await Actions.token.getBalance(client, {
      token: token as Hex.Hex,
      account: account.address,
    })
    if (balance > 0n) {
      // Quote the swap to get required input amount
      const quotedAmountIn = await Actions.dex
        .getBuyQuote(client, {
          tokenIn: token as Hex.Hex,
          tokenOut: targetToken,
          amountOut: amount,
        })
        .catch(() => {
          throw new Error(
            `Insufficient DEX liquidity to swap ${token} → ${targetToken} for amount ${amount}`,
          )
        })
      if (balance < quotedAmountIn)
        throw new Error(
          `Insufficient balance: have ${balance} of ${token}, need ${quotedAmountIn} to swap for ${amount} of ${targetToken}`,
        )
      return {
        type: 'swap',
        heldToken: token as `0x${string}`,
        targetToken,
        maxAmountIn: quotedAmountIn,
      }
    }
  }

  throw new Error(
    `No USD tokens available for settlement. Checked: ${[...settlementCurrencies, ...knownUsdTokens].join(', ')}`,
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
      const { amount, recipient, methodDetails, settlementCurrencies } = request

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

      // Legacy mode: currency is a token address — direct transfer (existing behavior)
      if (Currency.isTokenAddress(request.currency)) {
        return signAndSerialize([
          Actions.token.transfer.call({
            amount: BigInt(amount),
            memo,
            to: recipient as Hex.Hex,
            token: request.currency as Hex.Hex,
          }),
        ])
      }

      // Base currency mode: resolve settlement token
      if (!settlementCurrencies?.length)
        throw new Error('settlementCurrencies required when currency is a base currency code')

      const resolution = await resolveSettlement({
        client,
        account,
        amount: BigInt(amount),
        settlementCurrencies,
      })

      // Verify the chosen settlement token matches the declared base currency
      const chosenToken = (
        resolution.type === 'direct' ? resolution.token : resolution.targetToken
      ) as Hex.Hex
      const declaredCurrency = request.currency.toLowerCase()
      const metadata = await Actions.token.getMetadata(client, { token: chosenToken })
      if (metadata.currency?.toLowerCase() !== declaredCurrency)
        throw new Error(
          `Settlement token ${chosenToken} currency "${metadata.currency}" does not match declared currency "${declaredCurrency}"`,
        )

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
