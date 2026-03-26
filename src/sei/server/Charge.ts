import {
  type Address,
  type TransactionReceipt,
  decodeEventLog,
  getAddress,
  keccak256,
  parseAbi,
} from 'viem'
import { getTransactionReceipt, sendRawTransaction } from 'viem/actions'

import { PaymentExpiredError } from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import * as defaults from '../internal/defaults.js'
import { sei } from '../internal/chains.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'

const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/**
 * Creates a Sei charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { sei } from 'mppx/server'
 *
 * const charge = sei.charge()
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
    recipient,
    waitForConfirmation = true,
  } = parameters
  const store = (parameters.store ?? Store.memory()) as Store.Store<charge.StoreItemMap>

  const getClient = Client.getResolver({
    chain: sei,
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

    async request({ request }) {
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
      const { chainId } = request

      const client = await getClient({ chainId })

      const { request: challengeRequest } = challenge
      const { amount } = challengeRequest
      const expires = challenge.expires

      const currency = challengeRequest.currency as Address
      const recipient = challengeRequest.recipient as Address

      if (expires && new Date(expires) < new Date()) throw new PaymentExpiredError({ expires })

      const payload = credential.payload

      switch (payload.type) {
        case 'hash': {
          const hash = payload.hash as `0x${string}`
          await assertHashUnused(store, hash)

          const receipt = await getTransactionReceipt(client, { hash })

          assertTransferLog(receipt, {
            amount,
            currency,
            recipient,
          })

          await markHashUsed(store, hash)

          return toReceipt(receipt)
        }

        case 'transaction': {
          const serializedTransaction = payload.signature as `0x${string}`

          const hash = keccak256(serializedTransaction)
          await assertHashUnused(store, hash)
          await markHashUsed(store, hash)

          const reference = await sendRawTransaction(client, {
            serializedTransaction,
          })

          if (waitForConfirmation) {
            const receipt = await getTransactionReceipt(client, { hash: reference })

            assertTransferLog(receipt, {
              amount,
              currency,
              recipient,
            })

            if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
              await assertHashUnused(store, receipt.transactionHash)
              await markHashUsed(store, receipt.transactionHash)
            }

            return toReceipt(receipt)
          }

          if (reference.toLowerCase() !== hash.toLowerCase()) {
            await assertHashUnused(store, reference)
            await markHashUsed(store, reference)
          }
          return {
            method: 'sei',
            status: 'success',
            timestamp: new Date().toISOString(),
            reference,
          } as const
        }

        default:
          throw new Error(`Unsupported credential type "${(payload as { type: string }).type}".`)
      }
    },
  })
}

export declare namespace charge {
  type StoreItemMap = { [key: `mppx:charge:${string}`]: number }

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'recipient'>

  type Parameters = {
    /** Testnet mode. */
    testnet?: boolean | undefined
    /** Recipient address. */
    recipient?: Address | undefined
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
     */
    waitForConfirmation?: boolean | undefined
  } & Client.getResolver.Parameters &
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
    currency: Address
    recipient: Address
  },
): void {
  const { amount, currency, recipient } = parameters

  const match = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== currency.toLowerCase()) return false
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
      if (event.eventName !== 'Transfer') return false
      return (
        getAddress(event.args.to) === getAddress(recipient) &&
        event.args.value.toString() === amount
      )
    } catch {
      return false
    }
  })

  if (!match)
    throw new MismatchError('Payment verification failed: no matching transfer found.', {
      amount,
      currency,
      recipient,
    })
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
    method: 'sei',
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
