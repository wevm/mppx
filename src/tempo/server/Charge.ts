import {
  decodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  type TransactionReceipt,
  toFunctionSelector,
} from 'viem'
import { getTransactionReceipt, sendRawTransactionSync, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Transaction } from 'viem/tempo'
import { PaymentExpiredError } from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Client from '../../viem/Client.js'
import * as Account from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'

/** Maximum gas the server will co-sign when acting as fee payer. */
const MAX_FEE_PAYER_GAS = 500_000n

const transferSelector = /*#__PURE__*/ toFunctionSelector(
  'function transfer(address to, uint256 amount)',
)

const transferWithMemoSelector = /*#__PURE__*/ toFunctionSelector(
  'function transferWithMemo(address to, uint256 amount, bytes32 memo)',
)

// ---------------------------------------------------------------------------
// Shared verification helpers
// ---------------------------------------------------------------------------

/** Checks whether a Transfer/TransferWithMemo log matches the expected payment. */
function matchTransferLog(
  log: {
    address: `0x${string}`
    args: { to: `0x${string}`; amount: bigint; memo?: `0x${string}` }
  },
  options: {
    currency: `0x${string}`
    amount: string
    memo: `0x${string}` | undefined
    recipient: `0x${string}`
  },
): boolean {
  if (!isAddressEqual(log.address, options.currency)) return false
  if (!isAddressEqual(log.args.to, options.recipient)) return false
  if (log.args.amount.toString() !== options.amount) return false
  if (options.memo && log.args.memo?.toLowerCase() !== options.memo.toLowerCase()) return false
  return true
}

/** Checks whether a transaction call matches the expected payment. */
function matchTransferCall(
  call: { to?: `0x${string}` | null; data?: `0x${string}` },
  options: {
    currency: `0x${string}`
    amount: string
    memo: `0x${string}` | undefined
    recipient: `0x${string}`
  },
): boolean {
  if (!call.to || !isAddressEqual(call.to, options.currency)) return false
  if (!call.data) return false

  const selector = call.data.slice(0, 10)

  if (options.memo) {
    if (selector !== transferWithMemoSelector) return false
    try {
      const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
      const [to, amount_, memo_] = args as [`0x${string}`, bigint, `0x${string}`]
      return (
        isAddressEqual(to, options.recipient) &&
        amount_.toString() === options.amount &&
        memo_.toLowerCase() === options.memo.toLowerCase()
      )
    } catch {
      return false
    }
  }

  if (selector === transferSelector) {
    try {
      const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
      const [to, amount_] = args as [`0x${string}`, bigint]
      return isAddressEqual(to, options.recipient) && amount_.toString() === options.amount
    } catch {
      return false
    }
  }

  if (selector === transferWithMemoSelector) {
    try {
      const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
      const [to, amount_] = args as [`0x${string}`, bigint, `0x${string}`]
      return isAddressEqual(to, options.recipient) && amount_.toString() === options.amount
    } catch {
      return false
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// charge()
// ---------------------------------------------------------------------------

/**
 * Creates a Tempo charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { tempo } from 'mppx/server'
 *
 * const charge = tempo.charge({ currency: '0x20c0...' })
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
  } = parameters

  const { recipient, feePayer } = Account.resolve(parameters)

  const getClient = Client.getResolver({
    chain: { ...tempo_chain, experimental_preconfirmationTime: 500 },
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
        const requested = request.feePayer !== false && (account ?? feePayer)
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
      const { amount, expires, methodDetails } = challengeRequest

      const currency = challengeRequest.currency as `0x${string}`
      const recipient = challengeRequest.recipient as `0x${string}`

      if (expires && new Date(expires) < new Date()) throw new PaymentExpiredError({ expires })

      const memo = methodDetails?.memo as `0x${string}` | undefined

      const matchOptions = { currency, amount, memo, recipient }

      const payload = credential.payload

      switch (payload.type) {
        case 'hash': {
          const hash = payload.hash as `0x${string}`
          const receipt = await getTransactionReceipt(client, { hash })

          if (memo) {
            const memoLogs = parseEventLogs({
              abi: Abis.tip20,
              eventName: 'TransferWithMemo',
              logs: receipt.logs,
            })

            const match = memoLogs.find((log) => matchTransferLog(log as never, matchOptions))

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

            const match = [...transferLogs, ...memoLogs].find((log) =>
              matchTransferLog(log as never, matchOptions),
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

          const call = calls.find((c) => matchTransferCall(c as never, matchOptions))

          if (!call)
            throw new MismatchError('Invalid transaction: no matching payment call found', {
              amount,
              currency,
              recipient,
            })

          const serializedTransaction_final = await (async () => {
            if (feePayer && methodDetails?.feePayer === true) {
              if (transaction.gas && transaction.gas > MAX_FEE_PAYER_GAS)
                throw new Error(
                  `Transaction gas ${transaction.gas} exceeds fee payer limit ${MAX_FEE_PAYER_GAS}`,
                )
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
  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'feePayer' | 'recipient'>

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
