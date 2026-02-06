import { Base64 } from 'ox'
import type { Hex } from 'viem'
import type { StreamReceipt } from './Types.js'

/**
 * Create a stream receipt.
 */
export function createStreamReceipt(params: {
  challengeId: string
  channelId: Hex
  acceptedCumulative: bigint
  spent: bigint
  units?: number | undefined
  txHash?: Hex | undefined
}): StreamReceipt {
  return {
    method: 'tempo',
    intent: 'stream',
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
 * Serialize a stream receipt to the Payment-Receipt header format.
 */
export function serializeStreamReceipt(receipt: StreamReceipt): string {
  const json = JSON.stringify(receipt)
  return Base64.fromString(json, { pad: false, url: true })
}

/**
 * Deserialize a Payment-Receipt header value to a stream receipt.
 */
export function deserializeStreamReceipt(encoded: string): StreamReceipt {
  const json = Base64.toString(encoded)
  return JSON.parse(json) as StreamReceipt
}
