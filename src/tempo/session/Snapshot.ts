import { isAddress, type Address, type Hex } from 'viem'

import * as HeaderCodec from '../../internal/HeaderCodec.js'
import * as z from '../../zod.js'
import type { ChannelDescriptor, RawAmountString } from './precompile/Protocol.js'

/** Server-provided reusable channel state used to bootstrap a client session. */
export type SessionSnapshot = {
  /** Highest cumulative voucher amount the server has accepted for this channel. */
  acceptedCumulative: RawAmountString
  /** Tempo chain ID used to derive the channel ID and voucher domain. */
  chainId: number
  /** TIP-1034 channel ID derived from descriptor, escrow address, and chain ID. */
  channelId: Hex
  /** Timestamp when unilateral close was requested, when the channel is closing. */
  closeRequestedAt?: RawAmountString | undefined
  /** Current on-chain deposit ceiling for cumulative voucher authorization. */
  deposit: RawAmountString
  /** Full descriptor needed to recover the channel without client-side persistence. */
  descriptor: ChannelDescriptor
  /** Escrow precompile address used to derive the channel ID. */
  escrow: Address
  /** Minimum cumulative authorization needed for the challenged request or stream continuation. */
  requiredCumulative: RawAmountString
  /** Amount already settled on-chain. */
  settled: RawAmountString
  /** Amount consumed by delivered content according to server accounting. */
  spent: RawAmountString
  /** Paid units delivered by the server, when the transport reports them. */
  units?: number | undefined
}

const addressSchema = z.custom<Address>(
  (value) => typeof value === 'string' && isAddress(value, { strict: false }),
)
const hashSchema = z.custom<Hex>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
)

const channelDescriptorSchema = z.object({
  authorizedSigner: addressSchema,
  expiringNonceHash: hashSchema,
  operator: addressSchema,
  payee: addressSchema,
  payer: addressSchema,
  salt: hashSchema,
  token: addressSchema,
})

const sessionSnapshotSchema = z.object({
  acceptedCumulative: z.string(),
  chainId: z.number(),
  channelId: hashSchema,
  closeRequestedAt: z.optional(z.string()),
  deposit: z.string(),
  descriptor: channelDescriptorSchema,
  escrow: addressSchema,
  requiredCumulative: z.string(),
  settled: z.string(),
  spent: z.string(),
  units: z.optional(z.number()),
})

const sessionSnapshotHeader = HeaderCodec.createJson(sessionSnapshotSchema)

/** Serializes a session snapshot for the `Payment-Session-Snapshot` header. */
export function serializeSnapshot(snapshot: SessionSnapshot): string {
  return sessionSnapshotHeader.encode(snapshot)
}

/** Deserializes a session snapshot from the `Payment-Session-Snapshot` header. */
export function deserializeSnapshot(value: string): SessionSnapshot {
  return sessionSnapshotHeader.decode(value) as SessionSnapshot
}
