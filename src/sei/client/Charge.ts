import { type Address, encodeFunctionData, parseAbi } from 'viem'
import { prepareTransactionRequest, sendTransaction, signTransaction } from 'viem/actions'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import { sei } from '../internal/chains.js'
import * as Methods from '../Methods.js'

const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

/**
 * Creates a Sei charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { sei } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = sei.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: sei,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.charge, {
    context: z.object({
      account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
      mode: z.optional(z.enum(['push', 'pull'])),
    }),

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      const mode =
        context?.mode ?? parameters.mode ?? (account.type === 'json-rpc' ? 'push' : 'pull')

      const { request } = challenge
      const { amount } = request
      const currency = request.currency as Address
      const recipient = request.recipient as Address

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, BigInt(amount)],
      })

      if (mode === 'push') {
        const hash = await sendTransaction(client, {
          account,
          to: currency,
          data,
        })
        return Credential.serialize({
          challenge,
          payload: { hash, type: 'hash' },
          source: `did:pkh:eip155:${chainId}:${account.address}`,
        })
      }

      const prepared = await prepareTransactionRequest(client, {
        account,
        to: currency,
        data,
      })
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
