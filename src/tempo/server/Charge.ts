import {
  type Account,
  decodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  type TransactionReceipt,
  toFunctionSelector,
} from 'viem'
import { getTransactionReceipt, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Transaction } from 'viem/tempo'
import type { LooseOmit } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Client from '../../viem/Client.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'

const transferSelector = /*#__PURE__*/ toFunctionSelector(
  'function transfer(address to, uint256 amount)',
)

const transferWithMemoSelector = /*#__PURE__*/ toFunctionSelector(
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
)

/**
 * Creates a Tempo charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { tempo } from 'mpay/server'
 *
 * const charge = tempo.charge()
 * ```
 */
export function charge<const defaults extends charge.Defaults>(
  parameters: charge.Parameters<defaults> = {} as charge.Parameters<defaults>,
) {
  const {
    amount,
    client,
    currency,
    decimals = 6,
    description,
    externalId,
    memo,
    recipient,
  } = parameters

  const getClient = Client.getResolver({
    chain: { ...tempo_chain, experimental_preconfirmationTime: 500 },
    client,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = defaults & { decimals: number }
  return MethodIntent.toServer<typeof Intents.charge, Defaults>(Intents.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      memo,
      recipient,
    } as Defaults,

    // TODO: dedupe `{charge,stream}.request`
    request({ credential, request }) {
      // Extract chainId from request or default.
      const chainId = (() => {
        if (request.chainId) return request.chainId
        if (parameters.testnet) return defaults.testnetChainId
        return getClient(0).chain?.id
      })()

      // Validate chainId.
      const client = (() => {
        try {
          return getClient(chainId!)
        } catch {
          throw new Error(`No client configured with chainId ${chainId}.`)
        }
      })()
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)

      // Extract feePayer.
      const feePayer = (() => {
        const account =
          typeof request.feePayer === 'object' ? request.feePayer : parameters.feePayer
        const requested = request.feePayer !== false && (account ?? parameters.feePayer)
        if (credential) return account
        if (requested) return true
        return undefined
      })()

      return { ...request, chainId, feePayer }
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const { chainId, feePayer } = request

      const client = getClient(chainId!)

      const { request: challengeRequest } = challenge
      const { amount, expires, methodDetails } = challengeRequest

      const currency = challengeRequest.currency as `0x${string}`
      const recipient = challengeRequest.recipient as `0x${string}`

      if (expires && new Date(expires) < new Date()) throw new Error('Payment request expired')

      const payload = credential.payload

      switch (payload.type) {
        case 'hash': {
          const hash = payload.hash as `0x${string}`
          const receipt = await getTransactionReceipt(client, {
            hash,
          })

          const memo = methodDetails?.memo as `0x${string}` | undefined

          if (memo) {
            const memoLogs = parseEventLogs({
              abi: Abis.tip20,
              eventName: 'TransferWithMemo',
              logs: receipt.logs,
            })

            const match = memoLogs.find(
              (log) =>
                isAddressEqual(log.address, currency) &&
                isAddressEqual(log.args.to, recipient) &&
                log.args.amount.toString() === amount &&
                log.args.memo.toLowerCase() === memo.toLowerCase(),
            )

            if (!match)
              throw new MismatchError(
                'Payment verification failed: no matching transfer with memo found.',
                {
                  amount,
                  currency,
                  memo,
                  recipient,
                },
              )
          } else {
            const logs = parseEventLogs({
              abi: Abis.tip20,
              eventName: 'Transfer',
              logs: receipt.logs,
            })

            const match = logs.find(
              (log) =>
                isAddressEqual(log.address, currency) &&
                isAddressEqual(log.args.to, recipient) &&
                log.args.amount.toString() === amount,
            )

            if (!match)
              throw new MismatchError('Payment verification failed: no matching transfer found.', {
                amount,
                currency,
                recipient,
              })
          }

          return toReceipt(receipt)
        }

        case 'transaction': {
          const serializedTransaction = payload.signature as Transaction.TransactionSerializedTempo
          const transaction = Transaction.deserialize(serializedTransaction)

          const calls = transaction.calls ?? []
          const memo = methodDetails?.memo as `0x${string}` | undefined

          const call = calls.find((call) => {
            if (!call.to || !isAddressEqual(call.to, currency)) return false
            if (!call.data) return false

            const selector = call.data.slice(0, 10)

            if (memo) {
              if (selector !== transferWithMemoSelector) return false
              try {
                const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
                const [to, amount_, memo_] = args as [`0x${string}`, bigint, `0x${string}`]
                return (
                  isAddressEqual(to, recipient) &&
                  amount_.toString() === amount &&
                  memo_.toLowerCase() === memo.toLowerCase()
                )
              } catch {
                return false
              }
            }

            if (selector !== transferSelector) return false
            try {
              const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
              const [to, amount_] = args as [`0x${string}`, bigint]
              return isAddressEqual(to, recipient) && amount_.toString() === amount
            } catch {
              return false
            }
          })

          if (!call)
            throw new MismatchError('Invalid transaction: no matching payment call found', {
              amount,
              currency,
              recipient,
              memo: memo ?? '(none)',
            })

          const serializedTransaction_final = await (async () => {
            if (feePayer && methodDetails?.feePayer !== false) {
              return signTransaction(client, {
                ...transaction,
                account: feePayer,
                feePayer,
              } as never)
            }
            return serializedTransaction
          })()

          const receipt = await sendRawTransactionSync(client, {
            serializedTransaction: serializedTransaction_final,
          })

          return toReceipt(receipt)
        }

        default:
          throw new Error(`Unsupported credential type "${(payload as { type: string }).type}".`)
      }
    },
  })
}

export declare namespace charge {
  type Defaults = LooseOmit<MethodIntent.RequestDefaults<typeof Intents.charge>, 'feePayer'>

  type Parameters<defaults extends Defaults = {}> = {
    /** Optional fee payer account for covering transaction fees. */
    feePayer?: Account | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
  } & Client.getResolver.Parameters &
    defaults
}

/** @internal */
function toReceipt(receipt: TransactionReceipt) {
  const { status, transactionHash } = receipt
  if (status !== 'success') {
    throw new Error(`Transaction reverted: ${transactionHash}`)
  }
  return {
    method: 'tempo',
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
