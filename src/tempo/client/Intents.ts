import type * as Hex from 'ox/Hex'
import type { Account } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'
import * as Credential from '../../Credential.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'

/**
 * Creates a Tempo charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { tempo } from 'mpay/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = tempo.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const { client } = parameters

  const getClient = Client.getResolver({
    chain: tempo_chain,
    client,
    rpcUrl: defaults.rpcUrl,
  } as never)

  return MethodIntent.toClient(Intents.charge, {
    context: z.object({
      account: z.optional(z.custom<Account>()),
    }),

    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      const chainId = challenge.request.methodDetails?.chainId ?? 0
      const client = getClient(chainId)

      const { request } = challenge
      const { amount, currency, recipient, methodDetails } = request

      const prepared = await prepareTransactionRequest(client, {
        account,
        calls: [
          Actions.token.transfer.call({
            amount: BigInt(amount),
            memo: methodDetails?.memo as Hex.Hex | undefined,
            to: recipient as Hex.Hex,
            token: currency as Hex.Hex,
          }),
        ],
        ...(methodDetails?.feePayer && { feePayer: true }),
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
  type Parameters = Client.getResolver.Parameters & {
    /** Account to sign transactions with. Can be overridden per-call via context. */
    account?: Account | undefined
  }
}
