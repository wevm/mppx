import type * as Hex from 'ox/Hex'
import { type Account, type Client, createClient, http } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'
import * as Credential from '../../Credential.js'
import type { OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as Methods from '../Method.js'

/**
 * Creates a Tempo payment method for usage on the client.
 *
 * @example
 * ```ts
 * import { tempo } from 'mpay/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const method = tempo({
 *   account: privateKeyToAccount('0x...'),
 *   rpcUrl: 'https://rpc.tempo.xyz',
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters) {
  const client = (() => {
    if (parameters.client) return parameters.client
    return createClient({
      chain: {
        ...tempo_chain,
        id: parameters.chainId ?? tempo_chain.id,
      },
      transport: http(parameters.rpcUrl),
    })
  })()

  return Method.toClient(Methods.tempo, {
    context: z.object({
      account: z.optional(z.custom<Account>()),
    }),
    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      switch (challenge.intent) {
        case 'charge': {
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
          const signature = await signTransaction(client, prepared as never)

          return Credential.serialize({
            challenge,
            payload: { signature, type: 'transaction' },
            source: `did:pkh:eip155:${client.chain?.id}:${account.address}`,
          })
        }

        default:
          throw new Error(`Unsupported intent "${challenge.intent}".`)
      }
    },
  })
}

export declare namespace tempo {
  type Parameters = {
    /** Account to sign transactions with. Can be overridden per-call via context. */
    account?: Account | undefined
  } & OneOf<
    | {
        /** Viem Client. */
        client: Client
      }
    | {
        /** Tempo chain ID. */
        chainId?: number | undefined
        /** Tempo RPC URL. */
        rpcUrl: string
      }
  >
}
