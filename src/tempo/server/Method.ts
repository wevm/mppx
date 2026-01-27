import { AbiFunction, Address } from 'ox'
import {
  type Account,
  type Client,
  createClient,
  http,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem'
import { getTransactionReceipt, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Transaction } from 'viem/tempo'
import type { OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as Methods from './../Method.js'

const transfer = /*#__PURE__*/ AbiFunction.from(
  'function transfer(address to, uint256 amount) returns (bool)',
)
const transferSelector = /*#__PURE__*/ AbiFunction.getSelector(transfer)

const transferWithMemo = /*#__PURE__*/ AbiFunction.from(
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
)
const transferWithMemoSelector = /*#__PURE__*/ AbiFunction.getSelector(transferWithMemo)

/**
 * Creates a Tempo payment method for usage on the server.
 *
 * @example
 * ```ts
 * import { tempo } from 'mpay/server'
 *
 * const method = tempo({
 *   rpcUrl: 'https://rpc.tempo.xyz',
 *   chainId: 42431,
 * })
 * ```
 */
export function tempo(parameters: tempo.Parameters) {
  const { feePayer } = parameters

  const client = (() => {
    if (parameters.client) return parameters.client
    return createClient({
      chain: {
        ...tempo_chain,
        id: parameters.chainId,
      },
      transport: http(parameters.rpcUrl),
    })
  })()

  return Method.toServer(Methods.tempo, {
    context: z._default(
      z.object({
        feePayer: z.optional(z.custom<Account>()),
      }),
      { feePayer },
    ),
    request(options) {
      if (options.feePayer) return { feePayer: true, ...options.request }
      return options.request
    },
    async verify({ context, credential }) {
      const { feePayer } = context
      const { challenge } = credential

      switch (challenge.intent) {
        case 'charge': {
          const { request } = challenge
          const { amount, expires, methodDetails } = request

          const currency = request.currency as Address.Address
          const recipient = request.recipient as Address.Address

          if (new Date(expires) < new Date()) throw new Error('Payment request expired')

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
                    Address.isEqual(log.address, currency) &&
                    Address.isEqual(log.args.to, recipient) &&
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
                    Address.isEqual(log.address, currency) &&
                    Address.isEqual(log.args.to, recipient) &&
                    log.args.amount.toString() === amount,
                )

                if (!match)
                  throw new MismatchError(
                    'Payment verification failed: no matching transfer found.',
                    {
                      amount,
                      currency,
                      recipient,
                    },
                  )
              }

              return toReceipt(receipt)
            }

            case 'transaction': {
              const serializedTransaction =
                payload.signature as Transaction.TransactionSerializedTempo
              const transaction = Transaction.deserialize(serializedTransaction)

              const calls = transaction.calls ?? []

              if (calls.length !== 1)
                throw new MismatchError('Invalid transaction: unexpected number of calls', {
                  expected: '1',
                  got: String(calls.length),
                })

              const call = calls[0]!
              if (!call.to || !Address.isEqual(call.to, currency))
                throw new MismatchError(
                  'Invalid transaction: call target does not match currency',
                  {
                    expected: currency,
                    got: call.to ?? '(empty)',
                  },
                )

              if (!call.data)
                throw new MismatchError('Invalid transaction: call data is missing', {
                  expected: transferSelector,
                  got: '(empty)',
                })

              const memo = methodDetails?.memo as `0x${string}` | undefined
              const selector = call.data.slice(0, 10)

              if (memo) {
                if (selector !== transferWithMemoSelector)
                  throw new MismatchError('Invalid transaction: expected transferWithMemo call', {
                    expected: transferWithMemoSelector,
                    got: selector,
                  })

                const [to, amount_, memo_] = (() => {
                  try {
                    return AbiFunction.decodeData(transferWithMemo, call.data)
                  } catch {
                    throw new MismatchError(
                      'Invalid transaction: failed to decode transferWithMemo call',
                      {
                        expected: transferWithMemoSelector,
                        got: selector,
                      },
                    )
                  }
                })()

                if (!Address.isEqual(to, recipient))
                  throw new MismatchError('Invalid transaction: transfer recipient mismatch', {
                    expected: recipient,
                    got: to,
                  })

                if (amount_.toString() !== amount)
                  throw new MismatchError('Invalid transaction: transfer amount mismatch', {
                    expected: amount,
                    got: amount_.toString(),
                  })

                if (memo_.toLowerCase() !== memo.toLowerCase())
                  throw new MismatchError('Invalid transaction: memo mismatch', {
                    expected: memo,
                    got: memo_,
                  })
              } else {
                const [to, amount_] = (() => {
                  try {
                    return AbiFunction.decodeData(transfer, call.data)
                  } catch {
                    throw new MismatchError('Invalid transaction: failed to decode transfer call', {
                      expected: transferSelector,
                      got: selector,
                    })
                  }
                })()

                if (!Address.isEqual(to, recipient))
                  throw new MismatchError('Invalid transaction: transfer recipient mismatch', {
                    expected: recipient,
                    got: to,
                  })

                if (amount_.toString() !== amount)
                  throw new MismatchError('Invalid transaction: transfer amount mismatch', {
                    expected: amount,
                    got: amount_.toString(),
                  })
              }

              const serializedTransaction_final = await (async () => {
                if (methodDetails?.feePayer && feePayer) {
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
              throw new Error(
                `Unsupported credential type "${(payload as { type: string }).type}".`,
              )
          }
        }

        default:
          throw new Error(`Unsupported intent "${challenge.intent}".`)
      }
    },
  })
}

export declare namespace tempo {
  type Parameters = {
    /** Optional fee payer account for covering transaction fees. */
    feePayer?: Account | undefined
  } & OneOf<
    | {
        /** Viem Client. */
        client: Client
      }
    | {
        /** Tempo chain ID. */
        chainId: number
        /** Tempo RPC URL. */
        rpcUrl: string
      }
  >
}

/** @internal */
function toReceipt(receipt: TransactionReceipt) {
  const { status, transactionHash } = receipt
  return {
    method: 'tempo',
    status: status === 'success' ? 'success' : 'failed',
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
