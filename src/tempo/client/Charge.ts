import type { Address } from 'viem'
import { tempo as tempo_chain } from 'viem/tempo/chains'

import type * as Challenge from '../../Challenge.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Charge from '../Charge.js'
import * as AutoSwap from '../internal/auto-swap.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import * as MppAuthorize from './internal/MppAuthorize.js'

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
      const account = getAccount(client, context)
      const filled = await Charge.fill(client, {
        autoSwap: context?.autoSwap ?? parameters.autoSwap,
        challenge,
        clientId: parameters.clientId,
        expectedRecipients: parameters.expectedRecipients,
        payer: account.address,
      })
      if (account.type === 'json-rpc') {
        const authorization = await MppAuthorize.authorize(client, {
          account: account.address,
          challenge: challenge as Challenge.Challenge,
          chainId: filled.chainId,
        })
        if (authorization) return authorization
      }
      return Charge.createCredential(client, {
        filled,
        mode: context?.mode ?? parameters.mode,
        signer: account,
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
    mode?: Methods.ChargeMode | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
