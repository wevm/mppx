import type * as Challenge from '../../../Challenge.js'
import { sdkIdentifier } from '../../../internal/version.js'
import { machinePaymentMetadata } from '../../internal/constants.js'

/** Builds Stripe metadata used to identify and analyze MPP payments. */
export function buildAnalytics(parameters: {
  challenge?: Pick<Challenge.Challenge, 'id' | 'intent'> | undefined
  intent?: string | undefined
}): Record<string, string> {
  const { challenge, intent = challenge?.intent } = parameters
  const metadata = {
    ...machinePaymentMetadata,
    mpp_sdk: sdkIdentifier,
    ...(intent && { mpp_intent: intent }),
    ...(challenge && {
      mpp_challenge_id: challenge.id,
    }),
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, [...value].slice(0, 500).join('')]),
  )
}
