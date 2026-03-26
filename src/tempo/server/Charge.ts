import type { TempoAddress as TempoAddress_types } from 'ox/tempo'
import { decodeFunctionData, keccak256, parseEventLogs, type TransactionReceipt } from 'viem'
import {
  getTransactionReceipt,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
  call as viem_call,
} from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Transaction } from 'viem/tempo'

import { PaymentExpiredError } from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import * as Account from '../internal/account.js'
import * as TempoAddress from '../internal/address.js'
import * as defaults from '../internal/defaults.js'
import * as FeePayer from '../internal/fee-payer.js'
import * as Selectors from '../internal/selectors.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import { html } from './internal/html.gen.js'

/**
 * Creates a Tempo charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { tempo } from 'mppx/server'
 *
 * const charge = tempo.charge()
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
    memo,
    waitForConfirmation = true,
  } = parameters
  const store = (parameters.store ?? Store.memory()) as Store.Store<charge.StoreItemMap>

  const { recipient, feePayer, feePayerUrl } = Account.resolve(parameters)

  const getClient = Client.getResolver({
    chain: { ...tempo_chain, experimental_preconfirmationTime: 500 },
    feePayerUrl,
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
      memo,
      recipient,
    } as unknown as Defaults,

    ...(parameters.html ? { html: { content: html } } : {}),

    // TODO: dedupe `{charge,session}.request`
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

      const resolvedFeePayer = (() => {
        const account = typeof request.feePayer === 'object' ? request.feePayer : feePayer
        const requested = request.feePayer !== false && (account ?? feePayer ?? feePayerUrl)
        if (credential) return account
        if (requested) return true
        return undefined
      })()

      return {
        ...request,
        chainId,
        feePayer: resolvedFeePayer,
        memo: request.memo || undefined,
      }
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const { chainId, feePayer } = request

      const client = await getClient({ chainId })

      const { request: challengeRequest } = challenge
      const { amount, methodDetails } = challengeRequest
      const expires = challenge.expires

      const currency = challengeRequest.currency as `0x${string}`
      const recipient = challengeRequest.recipient as `0x${string}`

      if (expires && new Date(expires) < new Date()) throw new PaymentExpiredError({ expires })

      const memo = methodDetails?.memo as `0x${string}` | undefined

      const payload = credential.payload

      switch (payload.type) {
        case 'hash': {
          const hash = payload.hash as `0x${string}`
          await assertHashUnused(store, hash)

          const receipt = await getTransactionReceipt(client, {
            hash,
          })

          assertTransferLog(receipt, {
            amount,
            currency,
            from: receipt.from,
            memo,
            recipient,
          })

          await markHashUsed(store, hash)

          return toReceipt(receipt)
        }

        case 'transaction': {
          const serializedTransaction = payload.signature as Transaction.TransactionSerializedTempo

          // Pre-broadcast dedup: catch exact byte-for-byte replays early.
          const hash = keccak256(serializedTransaction)
          await assertHashUnused(store, hash)
          await markHashUsed(store, hash)

          if (!FeePayer.isTempoTransaction(serializedTransaction))
            throw new MismatchError('Only Tempo (0x76/0x78) transactions are supported.', {})

          const transaction = Transaction.deserialize(serializedTransaction)
          if (!transaction.signature || !transaction.from)
            throw new MismatchError(
              'Transaction must be signed by the sender before fee payer co-signing.',
              {},
            )

          const call = transaction.calls.find((call) => {
            if (!call.to || !TempoAddress.isEqual(call.to, currency)) return false
            if (!call.data) return false

            const selector = call.data.slice(0, 10)

            if (memo) {
              if (selector !== Selectors.transferWithMemo) return false
              try {
                const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
                const [to, amount_, memo_] = args as [`0x${string}`, bigint, `0x${string}`]
                return (
                  TempoAddress.isEqual(to, recipient) &&
                  amount_.toString() === amount &&
                  memo_.toLowerCase() === memo.toLowerCase()
                )
              } catch {
                return false
              }
            }

            if (selector === Selectors.transfer) {
              try {
                const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
                const [to, amount_] = args as [`0x${string}`, bigint]
                return TempoAddress.isEqual(to, recipient) && amount_.toString() === amount
              } catch {
                return false
              }
            }

            if (selector === Selectors.transferWithMemo) {
              try {
                const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
                const [to, amount_] = args as [`0x${string}`, bigint, `0x${string}`]
                return TempoAddress.isEqual(to, recipient) && amount_.toString() === amount
              } catch {
                return false
              }
            }

            return false
          })

          if (!call)
            throw new MismatchError('Invalid transaction: no matching payment call found', {
              amount,
              currency,
              recipient,
            })

          if ((feePayer || feePayerUrl) && methodDetails?.feePayer !== false)
            FeePayer.validateCalls(transaction.calls, { amount, currency, recipient })

          const resolvedFeeToken =
            transaction.feeToken ?? defaults.currency[chainId as keyof typeof defaults.currency]

          const serializedTransaction_final = await (async () => {
            if (feePayer && methodDetails?.feePayer !== false) {
              return signTransaction(client, {
                ...transaction,
                account: feePayer,
                feePayer,
                feeToken: resolvedFeeToken,
              } as never)
            }
            return serializedTransaction
          })()

          if (waitForConfirmation) {
            const receipt = await sendRawTransactionSync(client, {
              serializedTransaction: serializedTransaction_final,
            })
            assertTransferLog(receipt, {
              amount,
              currency,
              from: transaction.from,
              memo,
              recipient,
            })
            // Post-broadcast dedup: catch malleable input variants
            // (different serialized bytes, same underlying tx) that
            // bypass the pre-broadcast check. Skip if the broadcast
            // hash matches the input hash (already stored above).
            if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
              await assertHashUnused(store, receipt.transactionHash)
              await markHashUsed(store, receipt.transactionHash)
            }
            return toReceipt(receipt)
          } else {
            // Optimistic path: simulate to catch obvious reverts, then broadcast
            // without waiting for on-chain confirmation. The returned receipt
            // assumes success — callers opt into this risk via waitForConfirmation: false.
            await viem_call(client, {
              ...transaction,
              account: transaction.from,
              feeToken: resolvedFeeToken,
              calls: transaction.calls,
            } as never)
            const reference = await sendRawTransaction(client, {
              serializedTransaction: serializedTransaction_final,
            })
            // Post-broadcast dedup: same
            if (reference.toLowerCase() !== hash.toLowerCase()) {
              await assertHashUnused(store, reference)
              await markHashUsed(store, reference)
            }
            return {
              method: 'tempo',
              status: 'success',
              timestamp: new Date().toISOString(),
              reference,
            } as const
          }
        }

        default:
          throw new Error(`Unsupported credential type "${(payload as { type: string }).type}".`)
      }
    },
  })
}

export declare namespace charge {
  type StoreItemMap = { [key: `mppx:charge:${string}`]: number }

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'feePayer' | 'recipient'>

  type Parameters = {
    /** Enable the built-in HTML payment page for this method. @default false */
    html?: boolean | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
    /**
     * Store for transaction hash replay protection.
     *
     * Use a shared store in multi-instance deployments so consumed hashes are
     * visible across all server instances.
     */
    store?: Store.Store | undefined
    /**
     * Whether to wait for the charge transaction to confirm on-chain before
     * responding. @default true
     *
     * When `false`, the transaction is simulated via `eth_estimateGas` and
     * broadcast without waiting for inclusion. The receipt will optimistically
     * report `status: 'success'` based on simulation alone — if the
     * transaction reverts on-chain after broadcast (e.g. due to a state
     * change between simulation and inclusion), the receipt will not reflect
     * the failure.
     */
    waitForConfirmation?: boolean | undefined
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
function assertTransferLog(
  receipt: TransactionReceipt,
  parameters: {
    amount: string
    currency: TempoAddress_types.Address
    from: TempoAddress_types.Address
    memo: `0x${string}` | undefined
    recipient: TempoAddress_types.Address
  },
): void {
  const { amount, currency, from, memo, recipient } = parameters

  if (memo) {
    const memoLogs = parseEventLogs({
      abi: Abis.tip20,
      eventName: 'TransferWithMemo',
      logs: receipt.logs,
    })

    const match = memoLogs.find(
      (log) =>
        TempoAddress.isEqual(log.address, currency) &&
        TempoAddress.isEqual(log.args.from, from) &&
        TempoAddress.isEqual(log.args.to, recipient) &&
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
    const transferLogs = parseEventLogs({
      abi: Abis.tip20,
      eventName: 'Transfer',
      logs: receipt.logs,
    })

    const memoLogs = parseEventLogs({
      abi: Abis.tip20,
      eventName: 'TransferWithMemo',
      logs: receipt.logs,
    })

    const match = [...transferLogs, ...memoLogs].find(
      (log) =>
        TempoAddress.isEqual(log.address, currency) &&
        TempoAddress.isEqual(log.args.from, from) &&
        TempoAddress.isEqual(log.args.to, recipient) &&
        log.args.amount.toString() === amount,
    )

    if (!match)
      throw new MismatchError('Payment verification failed: no matching transfer found.', {
        amount,
        currency,
        recipient,
      })
  }
}

/** @internal */
function getHashStoreKey(hash: `0x${string}`): `mppx:charge:${string}` {
  return `mppx:charge:${hash.toLowerCase()}`
}

/** @internal */
async function assertHashUnused(
  store: Store.Store<charge.StoreItemMap>,
  hash: `0x${string}`,
): Promise<void> {
  const seen = await store.get(getHashStoreKey(hash))
  if (seen !== null) throw new Error('Transaction hash has already been used.')
}

/** @internal */
async function markHashUsed(
  store: Store.Store<charge.StoreItemMap>,
  hash: `0x${string}`,
): Promise<void> {
  await store.put(getHashStoreKey(hash), Date.now())
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
