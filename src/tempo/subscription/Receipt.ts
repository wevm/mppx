import type { SubscriptionRecord, SubscriptionReceipt } from './Types.js'

export function createSubscriptionReceipt(
  parameters: createSubscriptionReceipt.Parameters,
): SubscriptionReceipt {
  return {
    method: 'tempo',
    reference: parameters.reference,
    status: 'success',
    subscriptionId: parameters.subscriptionId,
    timestamp: parameters.timestamp,
    ...(parameters.externalId ? { externalId: parameters.externalId } : {}),
  }
}

export declare namespace createSubscriptionReceipt {
  type Parameters = Pick<
    SubscriptionRecord,
    'externalId' | 'reference' | 'subscriptionId' | 'timestamp'
  >
}

export function fromRecord(record: SubscriptionRecord): SubscriptionReceipt {
  return createSubscriptionReceipt(record)
}
