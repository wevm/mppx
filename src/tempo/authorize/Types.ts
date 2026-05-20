import type { Address, Hex } from 'viem'

import type * as Channel from '../precompile/Channel.js'

/** Durable state for a Tempo authorize channel. */
export type Authorization = {
  amount: string
  capturedAmount: string
  captureReceipts?: Record<string, Receipt> | undefined
  challengeId: string
  channel: {
    chainId: number
    descriptor: Channel.ChannelDescriptor
    escrow: Address
    id: Hex
  }
  openTxHash: Hex
  status: 'authorized' | 'closed' | 'voided'
}

/** Payment receipt emitted when a Tempo authorization captures value. */
export type Receipt = {
  authorizationId: Hex
  capturedAmount: string
  delta: string
  intent: 'authorize'
  method: 'tempo'
  reference: Hex
  status: 'success'
  timestamp: string
}
