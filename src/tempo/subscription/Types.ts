import type { Address } from 'viem'

export type SubscriptionIdentity = {
  id: string
}

export type SubscriptionResource = {
  id: string
}

export type SubscriptionAccessKey = {
  accessKeyAddress: Address
  keyType: 'p256' | 'secp256k1' | 'webAuthn'
}

export type SubscriptionRecord = {
  amount: string
  billingAnchor: string
  chainId?: number | undefined
  currency: Address | string
  externalId?: string | undefined
  identityId: string
  lastChargedPeriod: number
  periodSeconds: string
  recipient: Address | string
  reference: string
  resourceId: string
  subscriptionExpires: string
  subscriptionId: string
  timestamp: string
  canceledAt?: string | undefined
  revokedAt?: string | undefined
}

export type SubscriptionCredentialPayload = {
  signature: `0x${string}`
  type: 'keyAuthorization'
}

export type SubscriptionReceipt = {
  method: 'tempo'
  reference: string
  status: 'success'
  subscriptionId: string
  timestamp: string
  externalId?: string | undefined
}
