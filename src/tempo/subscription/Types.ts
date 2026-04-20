import type { Address } from 'viem'

/** Access key information used to authorize recurring Tempo payments. */
export type SubscriptionAccessKey = {
  accessKeyAddress: Address
  keyType: 'p256' | 'secp256k1' | 'webAuthn'
}

/** Request-scoped lookup key for the active subscription tied to a route. */
export type SubscriptionLookup = {
  key: string
}

/** Persisted recurring Tempo subscription state. */
export type SubscriptionRecord = {
  amount: string
  billingAnchor: string
  chainId?: number | undefined
  currency: Address | string
  externalId?: string | undefined
  lastChargedPeriod: number
  lookupKey: string
  periodSeconds: string
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
