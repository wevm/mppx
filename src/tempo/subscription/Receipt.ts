import type { SubscriptionRecord, SubscriptionReceipt } from './Types.js'

/** Creates a subscription receipt from persisted subscription fields. */
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
  /** Fields required to build a subscription receipt. */
  type Parameters = Pick<
    SubscriptionRecord,
    'externalId' | 'reference' | 'subscriptionId' | 'timestamp'
  >
}

/** Converts a stored subscription record into a receipt. */
export function fromRecord(record: SubscriptionRecord): SubscriptionReceipt {
  return createSubscriptionReceipt(record)
}
