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
import type { LooseOmit, OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from './../Method.js'

// Charge-only method for type-safe server implementation.
// Each server declares the intents it handles, giving proper type narrowing
// without any `as any` casts on credential/request unions.
const chargeMethod = Method.from({
  intents: { charge: Methods.tempo.intents.charge },
  name: 'tempo' as const,
})

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
 * const method = tempo.charge()
 * ```
 */
export function tempo<const defaults extends tempo.Defaults>(
  parameters: tempo.Parameters<defaults> = {} as tempo.Parameters<defaults>,
) {
  const { amount, currency, decimals = 6, description, externalId, memo, recipient } = parameters

  const rpcUrl = parameters.rpcUrl ?? defaults.rpcUrl

  function getClient(chainId: number): Client {
    if (parameters.client) return parameters.client(chainId)

    const url = rpcUrl[chainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${chainId}).`)

    return createClient({
      chain: {
        ...tempo_chain,
        id: chainId,
        experimental_preconfirmationTime: 500,
      },
      transport: http(url),
    })
  }

  type Defaults = defaults & { decimals: number }
  return Method.toServer<typeof chargeMethod, Defaults>(chargeMethod, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      memo,
      recipient,
    } as Defaults,

    request({ credential, request }) {
      const chainId = (() => {
        if (request.chainId) return request.chainId
        if (parameters.testnet) return defaults.testnetChainId
        return parameters.client?.(0).chain?.id ?? Number(Object.keys(rpcUrl)[0])!
      })()

      if (!parameters.client && !rpcUrl[chainId as keyof typeof rpcUrl])
        throw new Error(`No RPC URL configured for chainId ${chainId}.`)
      if (parameters.client && request.chainId) {
        const c = parameters.client(request.chainId)
        if (c.chain?.id !== undefined && c.chain.id !== request.chainId)
          throw new Error(`No RPC URL configured for chainId ${request.chainId}.`)
      }

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

      switch (challenge.intent) {
        case 'charge': {
          const { request } = challenge
          const { amount, expires, methodDetails } = request

          const currency = request.currency as Address.Address
          const recipient = request.recipient as Address.Address

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
              const memo = methodDetails?.memo as `0x${string}` | undefined

              const call = calls.find((call) => {
                if (!call.to || !Address.isEqual(call.to, currency)) return false
                if (!call.data) return false

                const selector = call.data.slice(0, 10)

                if (memo) {
                  if (selector !== transferWithMemoSelector) return false
                  try {
                    const [to, amount_, memo_] = AbiFunction.decodeData(transferWithMemo, call.data)
                    return (
                      Address.isEqual(to, recipient) &&
                      amount_.toString() === amount &&
                      memo_.toLowerCase() === memo.toLowerCase()
                    )
                  } catch {
                    return false
                  }
                }

                if (selector !== transferSelector) return false
                try {
                  const [to, amount_] = AbiFunction.decodeData(transfer, call.data)
                  return Address.isEqual(to, recipient) && amount_.toString() === amount
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
  /** Request fields that can be hoisted to `tempo.charge()` parameters (excluding feePayer which has different types). */
  type Defaults = LooseOmit<Method.RequestDefaults<(typeof chargeMethod)['intents']>, 'feePayer'>

  type Parameters<defaults extends Defaults = {}> = {
    /** Optional fee payer account for covering transaction fees. */
    feePayer?: Account | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
  } & defaults &
    OneOf<
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
