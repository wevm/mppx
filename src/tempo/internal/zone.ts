import { AbiParameters, Hash } from 'ox'
import {
  type Address,
  type Client,
  decodeFunctionData,
  getAbiItem,
  type Hex,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem'
import { getBlockNumber, getLogs } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'

import * as TempoAddress from './address.js'

/** Default time a payer waits for a Zone withdrawal to settle on Tempo. */
export const defaultSettlementTimeoutMs = 60_000

/** Number of Tempo blocks searched back for a settled Zone withdrawal. */
const lookbackBlocks = 7_200n

/** Time between polls for a settled Zone withdrawal. */
const pollingIntervalMs = 500

const withdrawalProcessed = getAbiItem({ abi: Abis.zonePortal, name: 'WithdrawalProcessed' })

/** A withdrawal as `ZonePortal.processWithdrawals` receives it on Tempo. */
export type Withdrawal = {
  token: Address
  senderTag: Hex
  to: Address
  amount: bigint
  memo: Hex
  gasLimit: bigint
  fallbackNonce: bigint
  callbackData: Hex
  encryptedSender: Hex
}

/** A `ZonePortal.WithdrawalProcessed` event. */
export type ProcessedEvent = {
  to: Address
  senderTag: Hex
  token: Address
  amount: bigint
  callbackSuccess: boolean
}

/** Zones a challenge accepts: a list of Zone IDs, or `true` for any Zone. */
export type Accepted = readonly number[] | true

/** Returns whether a value is a valid Zone ID: a positive 32-bit integer. */
export function isId(zoneId: number): boolean {
  return Number.isInteger(zoneId) && zoneId > 0 && zoneId < 2 ** 32
}

/** Returns whether a challenge's `zones` accepts withdrawals from a Zone. */
export function isAccepted(zones: Accepted | undefined, zoneId: number): boolean {
  if (!isId(zoneId)) return false
  return zones === true || (zones?.includes(zoneId) ?? false)
}

/** Returns the Tempo portal address of a Zone. */
export function portalAddress(zoneId: number): Address {
  return Addresses.zonePortal(zoneId) as Address
}

/**
 * Derives a Zone ID from a Zone chain ID.
 *
 * Zones on Tempo mainnet and Moderato use reserved bases (`421700000` and
 * `1424310000`). Zones on any other parent chain use `(parentChainId << 32) | zoneId`.
 */
export function idFromChainId(chainId: number): number {
  if (chainId >= 2 ** 32) return chainId % 2 ** 32
  if (chainId > 1_424_310_000 && chainId < 1_424_320_000) return chainId - 1_424_310_000
  if (chainId > 421_700_000 && chainId < 421_710_000) return chainId - 421_700_000
  throw new Error(`Cannot derive a Zone ID from chain ID ${chainId}. Pass \`zoneId\`.`)
}

/**
 * Derives the parent Tempo chain ID of a Zone chain ID, or `undefined` when
 * the chain ID doesn't follow a known Zone scheme.
 */
export function parentChainIdFromChainId(chainId: number): number | undefined {
  if (chainId >= 2 ** 32) return Math.floor(chainId / 2 ** 32)
  if (chainId > 1_424_310_000 && chainId < 1_424_320_000) return 42_431
  if (chainId > 421_700_000 && chainId < 421_710_000) return 4_217
  return undefined
}

/**
 * Derives a withdrawal's sender tag, which identifies it in the
 * `WithdrawalProcessed` event on Tempo.
 */
export function senderTag(parameters: {
  fallbackNonce: bigint
  sender: Address
  transactionHash: Hex
}): Hex {
  return Hash.keccak256(
    AbiParameters.encodePacked(
      ['address', 'bytes32', 'uint64'],
      [parameters.sender, parameters.transactionHash, parameters.fallbackNonce],
    ),
  )
}

/** Returns the `WithdrawalProcessed` event a portal emitted for a sender tag. */
export function findProcessedEvent(
  receipt: Pick<TransactionReceipt, 'logs'>,
  parameters: { portal: Address; senderTag: Hex },
): ProcessedEvent | undefined {
  const logs = parseEventLogs({ abi: [withdrawalProcessed], logs: receipt.logs })
  const log = logs.find(
    (log) =>
      TempoAddress.isEqual(log.address, parameters.portal) &&
      log.args.senderTag.toLowerCase() === parameters.senderTag.toLowerCase(),
  )
  return log?.args as ProcessedEvent | undefined
}

/**
 * Finds the withdrawal for a sender tag in the calldata of a settlement
 * transaction's top-level `processWithdrawals` calls to the portal.
 */
export function findWithdrawal(
  calls: readonly { to?: Address | null | undefined; data?: Hex | undefined }[],
  parameters: { portal: Address; senderTag: Hex },
): Withdrawal | undefined {
  for (const call of calls) {
    if (!call.to || !call.data || !TempoAddress.isEqual(call.to, parameters.portal)) continue
    let decoded
    try {
      decoded = decodeFunctionData({ abi: Abis.zonePortal, data: call.data })
    } catch {
      continue
    }
    if (decoded.functionName !== 'processWithdrawals') continue
    const [withdrawals] = decoded.args as unknown as [readonly Withdrawal[]]
    const withdrawal = withdrawals.find(
      (withdrawal) => withdrawal.senderTag.toLowerCase() === parameters.senderTag.toLowerCase(),
    )
    if (withdrawal) return withdrawal
  }
  return undefined
}

/**
 * Waits until a portal emits `WithdrawalProcessed` for a sender tag and
 * returns the Tempo transaction hash that settled it.
 */
export async function waitForSettlement(
  client: Client,
  parameters: {
    portal: Address
    senderTag: Hex
    to?: Address | undefined
    timeoutMs?: number | undefined
  },
): Promise<Hex> {
  const { timeoutMs = defaultSettlementTimeoutMs } = parameters
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error('Zone settlement timeout must be a finite, non-negative number.')
  let latest = await getBlockNumber(client, { cacheTime: 0 })
  // Scan the lookback window once, then only blocks added since the previous poll.
  let fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (fromBlock <= latest) {
      const logs = await getLogs(client, {
        address: parameters.portal,
        event: withdrawalProcessed,
        args: {
          senderTag: parameters.senderTag,
          ...(parameters.to ? { to: parameters.to } : {}),
        },
        fromBlock,
        toBlock: latest,
      })
      const hash = logs[0]?.transactionHash
      if (hash) return hash
      fromBlock = latest + 1n
    }
    if (Date.now() + pollingIntervalMs > deadline)
      throw new Error(
        `Zone withdrawal ${parameters.senderTag} did not settle on Tempo within ${timeoutMs}ms.`,
      )
    await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs))
    latest = await getBlockNumber(client, { cacheTime: 0 })
  }
}
