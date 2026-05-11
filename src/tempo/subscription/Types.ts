import type { Address } from 'viem'

/** Tempo-supported subscription period units. The shared intent also defines `month`, but Tempo cannot represent calendar-month periods exactly. */
export type SubscriptionPeriodUnit = 'day' | 'week'

/** Access key information used to authorize recurring Tempo payments. */
export type SubscriptionAccessKey = {
  accessKeyAddress: Address
  keyType: 'p256' | 'secp256k1' | 'webAuthn'
}

/** Server-owned subscription access key persisted for automatic billing. */
export type SubscriptionAccessKeyRecord = SubscriptionAccessKey & {
  privateKey: `0x${string}`
}

/** Request-scoped lookup key for the active subscription tied to a route. */
export type SubscriptionLookup = {
  accessKey?: SubscriptionAccessKey | undefined
  key: string
}

/** Persisted recurring Tempo subscription state. */
export type SubscriptionRecord = {
  amount: string
  billingAnchor: string
  chainId?: number | undefined
  currency: Address | string
  externalId?: string | undefined
  accessKey?: SubscriptionAccessKey | undefined
  inFlightPeriod?: number | undefined
  /** Per-attempt ownership token for the renewal currently in progress. */
  inFlightAttempt?: string | undefined
  /** Stable idempotency/reconciliation reference for a renewal currently in progress. */
  inFlightReference?: string | undefined
  inFlightStartedAt?: string | undefined
  /** Signed key authorization used to activate the access key. */
  keyAuthorization?: `0x${string}` | undefined
  lastChargedPeriod: number
  lookupKey: string
  /** Root account that authorized the stored subscription access key. */
  payer?: { address: Address; chainId: number } | undefined
  periodCount: string
  periodUnit: SubscriptionPeriodUnit
  recipient: Address | string
  reference: string
  subscriptionExpires: string
  subscriptionId: string
  timestamp: string
  canceledAt?: string | undefined
  revokedAt?: string | undefined
}

/** Credential payload for a Tempo subscription activation. */
export type SubscriptionCredentialPayload = {
  signature: `0x${string}`
  type: 'keyAuthorization'
}

/** Receipt returned for a Tempo subscription activation or renewal. */
export type SubscriptionReceipt = {
  method: 'tempo'
  reference: string
  status: 'success'
  subscriptionId: string
  timestamp: string
  externalId?: string | undefined
}
