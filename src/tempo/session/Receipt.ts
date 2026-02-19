import { Base64 } from 'ox'
import type { Hex } from 'viem'
import type { SessionReceipt } from './Types.js'

/**
 * Create a session receipt.
 */
export function createSessionReceipt(params: {
  challengeId: string
  channelId: Hex
  acceptedCumulative: bigint
  spent: bigint
  units?: number | undefined
  txHash?: Hex | undefined
}): SessionReceipt {
  return {
    method: 'tempo',
    intent: 'session',
    status: 'success',
    timestamp: new Date().toISOString(),
    reference: params.channelId,
    challengeId: params.challengeId,
    channelId: params.channelId,
    acceptedCumulative: params.acceptedCumulative.toString(),
    spent: params.spent.toString(),
    ...(params.units !== undefined && { units: params.units }),
    ...(params.txHash !== undefined && { txHash: params.txHash }),
  }
}

/**
 * Serialize a session receipt to the Payment-Receipt header format.
 */
export function serializeSessionReceipt(receipt: SessionReceipt): string {
  const json = JSON.stringify(receipt)
  return Base64.fromString(json, { pad: false, url: true })
}

/**
 * Deserialize a Payment-Receipt header value to a session receipt.
 */
export function deserializeSessionReceipt(encoded: string): SessionReceipt {
  const json = Base64.toString(encoded)
  return JSON.parse(json) as SessionReceipt
}
