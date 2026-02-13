import type * as Hex from 'ox/Hex'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'
import * as Credential from '../../Credential.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'

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

  return MethodIntent.toClient(Intents.charge, {
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

      const prepared = await prepareTransactionRequest(client, {
        account,
        calls: [
          Actions.token.transfer.call({
            amount: BigInt(amount),
            memo,
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
  type Parameters = {
    /** Client identifier used to derive the client fingerprint in attribution memos. */
    clientId?: string | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
