import type * as Hex from 'ox/Hex'
import { type Account, type Client, createClient, http } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'
import * as Credential from '../../Credential.js'
import type { OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Method.js'

/**
 * Creates a Tempo payment method for usage on the client.
 *
 * @example
 * ```ts
 * import { tempo } from 'mpay/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const method = tempo.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters = {}) {
  const rpcUrl = parameters.rpcUrl ?? defaults.rpcUrl

  function getClient(chainId: number): Client {
    if (parameters.client) return parameters.client(chainId)

    const url = rpcUrl[chainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${chainId}).`)

    return createClient({
      chain: { ...tempo_chain, id: chainId },
      transport: http(url),
    })
  }

  return Method.toClient(Methods.tempo, {
    context: z.object({
      account: z.optional(z.custom<Account>()),
    }),

    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      const chainId = (challenge.request.methodDetails?.chainId ?? Number(Object.keys(rpcUrl)[0]))!
      const client = getClient(chainId)

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
          // FIXME: figure out gas estimation issue for fee payer tx
          prepared.gas = prepared.gas! + 5_000n
          const signature = await signTransaction(client, prepared as never)

          return Credential.serialize({
            challenge,
            payload: { signature, type: 'transaction' },
            source: `did:pkh:eip155:${chainId}:${account.address}`,
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
        /** Function that returns a client for the given chain ID. */
        client?: ((chainId: number) => Client) | undefined
      }
    | {
        /** RPC URLs keyed by chain ID. */
        rpcUrl?: ({ [chainId: number]: string } & object) | undefined
      }
  >
}
