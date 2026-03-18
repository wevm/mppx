import {
  type Hex,
  type TransactionReceipt,
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  parseSignature,
} from 'viem'
import {
  getTransactionReceipt,
  sendTransaction,
  waitForTransactionReceipt,
} from 'viem/actions'
import { PaymentExpiredError } from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Client from '../../viem/Client.js'
import * as Abi from '../internal/abi.js'
import * as Account from '../internal/account.js'
import { radiusMainnet, radiusTestnet } from '../internal/chain.js'
import * as defaults from '../internal/defaults.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'

/**
 * Creates a Radius charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { radius } from 'mppx/server'
 *
 * const charge = radius.charge({
 *   currency: '0x33ad...14fb',
 *   recipient: '0x...',
 * })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(
  parameters: parameters = {} as parameters,
) {
  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
  } = parameters

  const { account, recipient } = Account.resolve(parameters)

  const getClient = Client.getResolver({
    chain: parameters.testnet ? radiusTestnet : radiusMainnet,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = charge.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      recipient,
    } as unknown as Defaults,

    async request({ credential, request }) {
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.testnet) return defaults.chainId.testnet
        return (await getClient({})).chain?.id
      })()

      const client = await (async () => {
        try {
          return await getClient({ chainId })
        } catch {
          throw new Error(`No client configured with chainId ${chainId}.`)
        }
      })()
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)

      return {
        ...request,
        chainId,
      }
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const chainId = request.chainId

      const client = await getClient({ chainId })

      const { request: challengeRequest } = challenge
      const { amount } = challengeRequest
      const expires = challenge.expires

      const currency = challengeRequest.currency as Hex
      const recipient = challengeRequest.recipient as Hex

      if (expires && new Date(expires) < new Date()) throw new PaymentExpiredError({ expires })

      const payload = credential.payload

      switch (payload.type) {
        case 'hash': {
          const hash = payload.hash as Hex
          const receipt = await getTransactionReceipt(client, { hash })

          const transferLogs = parseEventLogs({
            abi: Abi.erc20,
            eventName: 'Transfer',
            logs: receipt.logs,
          })

          const match = transferLogs.find(
            (log) =>
              isAddressEqual(log.address, currency) &&
              isAddressEqual(log.args.to, recipient) &&
              log.args.value.toString() === amount,
          )

          if (!match)
            throw new MismatchError('Payment verification failed: no matching transfer found.', {
              amount,
              currency,
              recipient,
            })

          return toReceipt(receipt)
        }

        case 'permit': {
          if (!account)
            throw new Error(
              'Server `account` is required to settle permit credentials. ' +
                'Pass an `Account` to the radius charge method parameters.',
            )

          const owner = payload.owner as Hex
          const deadline = BigInt(payload.deadline)
          const { v, r, s } = parseSignature(payload.signature as Hex)

          // Execute permit() — approve the server to spend on behalf of the payer
          const permitHash = await sendTransaction(client, {
            account,
            to: currency,
            data: encodeFunctionData({
              abi: Abi.erc20,
              functionName: 'permit',
              args: [owner, recipient, BigInt(amount), deadline, Number(v), r, s],
            }),
          } as never)
          await waitForTransactionReceipt(client, { hash: permitHash })

          // Execute transferFrom() — move tokens from payer to recipient
          const transferHash = await sendTransaction(client, {
            account,
            to: currency,
            data: encodeFunctionData({
              abi: Abi.erc20,
              functionName: 'transferFrom',
              args: [owner, recipient, BigInt(amount)],
            }),
          } as never)
          const receipt = await waitForTransactionReceipt(client, { hash: transferHash })

          return toReceipt(receipt)
        }

        default:
          throw new Error(`Unsupported credential type "${(payload as { type: string }).type}".`)
      }
    },
  })
}

export declare namespace charge {
  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'recipient'>

  type Parameters = {
    /** Testnet mode. */
    testnet?: boolean | undefined
  } & Client.getResolver.Parameters &
    Account.resolve.Parameters &
    Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
  }
}

/** @internal */
function toReceipt(receipt: TransactionReceipt) {
  const { status, transactionHash } = receipt
  if (status !== 'success') {
    throw new Error(`Transaction reverted: ${transactionHash}`)
  }
  return {
    method: 'radius',
    status: 'success',
    timestamp: new Date().toISOString(),
    reference: transactionHash,
  } as const
}

/** @internal */
class MismatchError extends Error {
  override readonly name = 'MismatchError'

  constructor(reason: string, details: Record<string, string>) {
    super([reason, ...Object.entries(details).map(([k, v]) => `  - ${k}: ${v}`)].join('\n'))
  }
}
