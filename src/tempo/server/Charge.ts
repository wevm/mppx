import {
  decodeFunctionData,
  formatUnits,
  keccak256,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem'
import {
  getTransactionReceipt,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
  verifyTypedData,
  call as viem_call,
} from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Abis, Actions, Transaction } from 'viem/tempo'

import { PaymentError, VerificationFailedError } from '../../Errors.js'
import * as Expires from '../../Expires.js'
import type { LooseOmit, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type * as Html from '../../server/internal/html/config.ts'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import type * as z from '../../zod.js'
import * as Attribution from '../Attribution.js'
import * as Account from '../internal/account.js'
import * as TempoAddress from '../internal/address.js'
import * as Charge_internal from '../internal/charge.js'
import * as defaults from '../internal/defaults.js'
import * as FeePayer from '../internal/fee-payer.js'
import * as Proof from '../internal/proof.js'
import * as Selectors from '../internal/selectors.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import { html as htmlContent } from './internal/html.gen.js'

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
  parameters: NoExtraKeys<parameters, charge.Parameters> = {} as NoExtraKeys<
    parameters,
    charge.Parameters
  >,
) {
  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
    html,
    memo,
    waitForConfirmation = true,
  } = parameters
  const store = (parameters.store ?? Store.memory()) as Store.Store<charge.StoreItemMap>
  const proofStore = parameters.store as Store.Store<charge.StoreItemMap> | undefined

  const { recipient, feePayer, feePayerUrl } = Account.resolve(parameters)

  const getClient = Client.getResolver({
    chain: { ...tempo_chain, experimental_preconfirmationTime: 500 },
    feePayerUrl,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = charge.DeriveDefaults<parameters>
  type ResolvedRequest = z.input<typeof Methods.charge.schema.request>
  return Method.toServer<typeof Methods.charge, Defaults, undefined, ResolvedRequest>(
    Methods.charge,
    {
      defaults: {
        amount,
        currency,
        decimals,
        description,
        externalId,
        memo,
        recipient,
      } as unknown as Defaults,

      html: html
        ? {
            config: {},
            content: htmlContent,
            formatAmount: async (request: z.output<typeof Methods.charge.schema.request>) => {
              try {
                const chainId = request.methodDetails?.chainId
                if (chainId === undefined) throw new Error('no chainId')
                const client = await getClient({ chainId })
                const metadata = await Actions.token.getMetadata(client, {
                  token: request.currency as `0x${string}`,
                })
                const symbol =
                  new Intl.NumberFormat('en', {
                    style: 'currency',
                    currency: metadata.currency,
                    currencyDisplay: 'narrowSymbol',
                  })
                    .formatToParts(0)
                    .find((p) => p.type === 'currency')?.value ?? metadata.currency
                return `${symbol}${formatUnits(BigInt(request.amount), metadata.decimals)}`
              } catch {
                return `$${request.amount}`
              }
            },
            text: typeof html === 'object' ? html.text : undefined,
            theme: typeof html === 'object' ? html.theme : undefined,
          }
        : undefined,

      // TODO: dedupe `{charge,session}.challenge`
      async challenge({ request }) {
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
          const requested =
            request.feePayer !== false && (request.feePayer ?? feePayer ?? feePayerUrl)
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

      async request({ requestInput }) {
        const chainId = await (async () => {
          if (requestInput.chainId) return requestInput.chainId
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

        const account = typeof requestInput.feePayer === 'object' ? requestInput.feePayer : feePayer
        return {
          ...requestInput,
          chainId,
          feePayer: account,
          memo: requestInput.memo || undefined,
        }
      },

      async verify({ envelope, request }) {
        const { challenge, credential } = envelope
        const resolvedRequest = Methods.charge.schema.request.parse(request)
        const chainId = resolvedRequest.methodDetails?.chainId ?? request.chainId
        const resolvedFeePayer = typeof request.feePayer === 'object' ? request.feePayer : undefined

        const client = await getClient({ chainId })

        const { amount, methodDetails } = resolvedRequest
        const expires = challenge.expires

        const currency = resolvedRequest.currency as `0x${string}`
        const recipient = resolvedRequest.recipient as `0x${string}`

        Expires.assert(expires, challenge.id)

        const memo = methodDetails?.memo as `0x${string}` | undefined

        const payload = credential.payload
        const isZeroAmount = BigInt(amount) === 0n

        if (isZeroAmount && payload.type !== 'proof')
          throw new MismatchError('Zero-amount challenges require a proof credential.', {})

        switch (payload.type) {
          case 'hash': {
            const hash = payload.hash as `0x${string}`
            await assertHashUnused(store, hash)

            const expectedTransfers = getExpectedTransfers({
              amount,
              memo,
              methodDetails,
              recipient,
            })
            const receipt = await getTransactionReceipt(client, { hash })
            const matchedLogs = assertTransferLogs(receipt, {
              currency,
              sender: receipt.from,
              transfers: expectedTransfers,
            })

            // Only verify challenge binding when using auto-generated attribution memos.
            // Explicit memos (set by the server) are strictly matched by assertTransferLogs
            // but are NOT challenge-bound — callers that set explicit memos are responsible
            // for ensuring memo uniqueness per challenge to prevent cross-challenge hash reuse.
            if (!memo)
              assertChallengeBoundMemo(matchedLogs, {
                challengeId: challenge.id,
                realm: challenge.realm,
              })

            await markHashUsed(store, hash)

            return toReceipt(receipt)
          }

          case 'proof': {
            if (!isZeroAmount)
              throw new MismatchError(
                'Proof credentials are only valid for zero-amount challenges.',
                {},
              )

            const expectedSource = credential.source
            if (!expectedSource)
              throw new MismatchError('Proof credential must include a source.', {})

            const resolvedChainId = challenge.request.methodDetails?.chainId ?? chainId!
            const source = Proof.parseProofSource(expectedSource)

            if (!source || source.chainId !== resolvedChainId) {
              throw new MismatchError('Proof credential source is invalid.', {})
            }

            const valid = await verifyTypedData(client, {
              address: source.address,
              domain: Proof.domain(resolvedChainId),
              types: Proof.types,
              primaryType: 'Proof',
              message: Proof.message(challenge.id),
              signature: payload.signature as `0x${string}`,
            })
            if (!valid) throw new MismatchError('Proof signature does not match source.', {})

            if (proofStore) {
              await assertProofUnused(proofStore, challenge.id)
              await markProofUsed(proofStore, challenge.id)
            }

            return {
              method: 'tempo',
              status: 'success',
              timestamp: new Date().toISOString(),
              reference: challenge.id,
            } as const
          }

          case 'transaction': {
            const serializedTransaction =
              payload.signature as Transaction.TransactionSerializedTempo

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

            const calls = (transaction.calls ?? []) as readonly {
              data?: `0x${string}` | undefined
              to?: `0x${string}` | undefined
            }[]
            const transfers = getExpectedTransfers({ amount, memo, methodDetails, recipient })
            const isFeePayerTx =
              !!(resolvedFeePayer || feePayerUrl) && methodDetails?.feePayer !== false
            assertTransferCalls(calls, { currency, exactCount: isFeePayerTx, transfers })

            if (isFeePayerTx)
              FeePayer.validateCalls(transaction.calls, { amount, currency, recipient })

            const resolvedFeeToken =
              transaction.feeToken ??
              (chainId !== undefined ? defaults.resolveCurrency({ chainId }) : undefined)

            const serializedTransaction_final = await (async () => {
              if (resolvedFeePayer && methodDetails?.feePayer !== false) {
                return signTransaction(client, {
                  ...transaction,
                  account: resolvedFeePayer,
                  feePayer: resolvedFeePayer,
                  feeToken: resolvedFeeToken,
                } as never)
              }
              return serializedTransaction
            })()

            if (waitForConfirmation) {
              const receipt = await sendRawTransactionSync(client, {
                serializedTransaction: serializedTransaction_final,
              })
              assertTransferLogs(receipt, {
                currency,
                sender: transaction.from! as `0x${string}`,
                transfers,
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
    },
  )
}

export declare namespace charge {
  type StoreItemMap = { [key: `mppx:charge:${string}`]: number }

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'feePayer' | 'recipient'>

  type Parameters = {
    /** Render payment page when Accept header is text/html (e.g. in browsers) */
    html?: boolean | Html.Config | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
    /**
     * Store for charge replay protection.
     *
     * Non-zero charge flows default to an in-memory store if omitted. For
     * zero-dollar proof auth, replay prevention is enabled only when a store
     * is explicitly provided; otherwise proofs remain reusable until the
     * challenge expires.
     *
     * Use a shared store in multi-instance deployments so consumed hashes and
     * proofs are visible across all server instances.
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

type ExpectedTransfer = {
  amount: string
  allowAnyMemo?: boolean | undefined
  memo?: `0x${string}` | undefined
  recipient: `0x${string}`
}

function getExpectedTransfers(parameters: {
  amount: string
  memo: `0x${string}` | undefined
  methodDetails: { splits?: readonly Charge_internal.Split[] | undefined } | undefined
  recipient: `0x${string}`
}): ExpectedTransfer[] {
  return Charge_internal.getTransfers({
    amount: parameters.amount,
    methodDetails: {
      memo: parameters.memo,
      splits: parameters.methodDetails?.splits,
    },
    recipient: parameters.recipient,
  }).map((transfer) => ({
    ...transfer,
    ...(!transfer.memo ? { allowAnyMemo: true } : {}),
  })) as ExpectedTransfer[]
}

function assertTransferCalls(
  calls: readonly { data?: `0x${string}` | undefined; to?: `0x${string}` | undefined }[],
  parameters: {
    currency: `0x${string}`
    exactCount?: boolean | undefined
    transfers: readonly ExpectedTransfer[]
  },
) {
  const transferCalls = getTransferCalls(calls)

  if (parameters.exactCount && transferCalls.length !== parameters.transfers.length)
    throw new MismatchError('Invalid transaction: no matching payment call found', {
      expectedCalls: String(parameters.transfers.length),
      actualCalls: String(transferCalls.length),
    })

  const used = new Set<number>()

  // Match memo-specific transfers before wildcards to avoid greedy
  // consumption of memo-bearing calls by allowAnyMemo entries.
  const sorted = [...parameters.transfers].sort((a, b) => {
    if (a.memo && !b.memo) return -1
    if (!a.memo && b.memo) return 1
    return 0
  })

  for (const expected of sorted) {
    const matchIndex = transferCalls.findIndex((call, index) => {
      if (used.has(index)) return false
      const decoded = decodeTransferCall(call, parameters.currency)
      if (!decoded) return false

      if (!TempoAddress.isEqual(decoded.recipient, expected.recipient)) return false
      if (decoded.amount !== expected.amount) return false
      if (expected.memo) {
        return decoded.memo?.toLowerCase() === expected.memo.toLowerCase()
      }
      if (expected.allowAnyMemo) return true
      return decoded.memo === undefined
    })

    if (matchIndex === -1) {
      throw new MismatchError('Invalid transaction: no matching payment call found', {
        amount: expected.amount,
        currency: parameters.currency,
        recipient: expected.recipient,
      })
    }

    used.add(matchIndex)
  }
}

function getTransferCalls(
  calls: readonly { data?: `0x${string}` | undefined; to?: `0x${string}` | undefined }[],
) {
  const selectors = calls.map((call) => call.data?.slice(0, 10))
  const offset =
    selectors[0] === Selectors.approve && selectors[1] === Selectors.swapExactAmountOut ? 2 : 0
  const transferCalls = calls.slice(offset)

  if (
    transferCalls.length === 0 ||
    selectors
      .slice(offset)
      .some(
        (selector) => selector !== Selectors.transfer && selector !== Selectors.transferWithMemo,
      )
  ) {
    throw new MismatchError('Invalid transaction: no matching payment call found', {})
  }

  return transferCalls
}

function decodeTransferCall(
  call: { data?: `0x${string}` | undefined; to?: `0x${string}` | undefined },
  currency: `0x${string}`,
) {
  if (!call.to || !TempoAddress.isEqual(call.to, currency) || !call.data) return null

  try {
    const selector = call.data.slice(0, 10)
    if (selector === Selectors.transfer) {
      const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
      const [recipient, amount] = args as [`0x${string}`, bigint]
      return { amount: amount.toString(), recipient }
    }

    if (selector === Selectors.transferWithMemo) {
      const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
      const [recipient, amount, memo] = args as [`0x${string}`, bigint, `0x${string}`]
      return { amount: amount.toString(), memo, recipient }
    }
  } catch {
    return null
  }

  return null
}

type TransferLog =
  | {
      kind: 'transfer'
      args: { from: `0x${string}`; to: `0x${string}`; amount: bigint }
      address: `0x${string}`
    }
  | {
      kind: 'memo'
      args: { from: `0x${string}`; to: `0x${string}`; amount: bigint; memo: `0x${string}` }
      address: `0x${string}`
    }

function assertTransferLogs(
  receipt: TransactionReceipt,
  parameters: {
    currency: `0x${string}`
    sender: `0x${string}`
    transfers: readonly ExpectedTransfer[]
  },
): TransferLog[] {
  const transferLogs = parseEventLogs({
    abi: Abis.tip20,
    eventName: 'Transfer',
    logs: receipt.logs,
  }).map((log) => ({ ...log, kind: 'transfer' as const }))

  const memoLogs = parseEventLogs({
    abi: Abis.tip20,
    eventName: 'TransferWithMemo',
    logs: receipt.logs,
  }).map((log) => ({ ...log, kind: 'memo' as const }))

  // Prefer memo logs so allowAnyMemo matches TransferWithMemo before Transfer,
  // preserving the memo for challenge binding verification.
  const logs = [...memoLogs, ...transferLogs]
  const used = new Set<number>()
  const matched: TransferLog[] = []

  // Match memo-specific transfers before wildcards to avoid greedy
  // consumption of memo-bearing logs by allowAnyMemo entries.
  const sorted = [...parameters.transfers].sort((a, b) => {
    if (a.memo && !b.memo) return -1
    if (!a.memo && b.memo) return 1
    return 0
  })

  for (const transfer of sorted) {
    const matchIndex = logs.findIndex((log, index) => {
      if (used.has(index)) return false
      if (!TempoAddress.isEqual(log.address, parameters.currency)) return false
      if (!TempoAddress.isEqual(log.args.from, parameters.sender)) return false
      if (!TempoAddress.isEqual(log.args.to, transfer.recipient)) return false
      if (log.args.amount.toString() !== transfer.amount) return false
      if (transfer.memo) {
        return log.kind === 'memo' && log.args.memo.toLowerCase() === transfer.memo.toLowerCase()
      }
      if (transfer.allowAnyMemo) return log.kind === 'transfer' || log.kind === 'memo'
      return log.kind === 'transfer'
    })

    if (matchIndex === -1) {
      throw new MismatchError('Payment verification failed: no matching transfer found.', {
        amount: transfer.amount,
        currency: parameters.currency,
        recipient: transfer.recipient,
      })
    }

    used.add(matchIndex)
    matched.push(logs[matchIndex]! as TransferLog)
  }

  return matched
}

/** @internal */
function getHashStoreKey(hash: `0x${string}`): `mppx:charge:${string}` {
  return `mppx:charge:${hash.toLowerCase()}`
}

/** @internal */
function getProofStoreKey(challengeId: string): `mppx:charge:${string}` {
  return `mppx:charge:proof:${challengeId}`
}

/** @internal */
async function assertHashUnused(
  store: Store.Store<charge.StoreItemMap>,
  hash: `0x${string}`,
): Promise<void> {
  const seen = await store.get(getHashStoreKey(hash))
  if (seen !== null)
    throw new VerificationFailedError({ reason: 'Transaction hash has already been used' })
}

/** @internal */
async function markHashUsed(
  store: Store.Store<charge.StoreItemMap>,
  hash: `0x${string}`,
): Promise<void> {
  await store.put(getHashStoreKey(hash), Date.now())
}

/** @internal */
async function assertProofUnused(
  store: Store.Store<charge.StoreItemMap>,
  challengeId: string,
): Promise<void> {
  const seen = await store.get(getProofStoreKey(challengeId))
  if (seen !== null)
    throw new VerificationFailedError({ reason: 'Proof credential has already been used' })
}

/** @internal */
async function markProofUsed(
  store: Store.Store<charge.StoreItemMap>,
  challengeId: string,
): Promise<void> {
  await store.put(getProofStoreKey(challengeId), Date.now())
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

/**
 * Asserts that at least one of the matched payment logs carries a
 * challenge-bound memo nonce (keccak256(challengeId)[0..6] in bytes 25–31).
 * Only checks logs that were matched by `assertTransferLogs`, not the
 * entire receipt — preventing unrelated dust transfers from satisfying
 * the binding.
 * @internal
 */
function assertChallengeBoundMemo(
  matchedLogs: readonly TransferLog[],
  parameters: { challengeId: string; realm: string },
) {
  const bound = matchedLogs.some((log) => {
    if (log.kind !== 'memo') return false
    if (!Attribution.verifyServer(log.args.memo, parameters.realm)) return false
    return Attribution.verifyChallengeBinding(log.args.memo, parameters.challengeId)
  })

  if (!bound)
    throw new MismatchError('Payment verification failed: memo is not bound to this challenge.', {})
}

/** @internal */
class MismatchError extends PaymentError {
  override readonly name = 'MismatchError'
  readonly title = 'Verification Failed'
  readonly type = 'https://paymentauth.org/problems/verification-failed'

  constructor(reason: string, details: Record<string, string>) {
    super([reason, ...Object.entries(details).map(([k, v]) => `  - ${k}: ${v}`)].join('\n'))
  }
}
