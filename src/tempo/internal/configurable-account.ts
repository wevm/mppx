import type { Address, Hex } from 'ox'
import { AccountConfig, SignatureEnvelope } from 'ox/tempo'

import * as TempoAddress from './address.js'

/** Returns whether a signature envelope type is a TIP-1020 primitive signature. */
export function isPrimitiveEnvelope(type: string): boolean {
  return type === 'secp256k1' || type === 'p256' || type === 'webAuthn'
}

/** Returns whether a config commitment is missing or zero (no config committed). */
export function isZeroCommitment(commitment: Hex.Hex | undefined): boolean {
  return commitment === undefined || BigInt(commitment) === 0n
}

/**
 * Verifies the owner approvals of a TIP-1107 configurable account signature over `payload`: each
 * approval is a primitive signature over the configurable account digest, recovered owners are
 * strictly ascending, their weight reaches the threshold, and no approval is excess.
 */
export function verifyApprovals(
  envelope: SignatureEnvelope.Configurable,
  payload: Hex.Hex,
): boolean {
  const { account, config, signatures } = envelope
  const digest = AccountConfig.getSignPayload({ account, config, payload })
  const threshold = Number(config.threshold)
  let previous: bigint | undefined
  let weight = 0
  let minWeight: number | undefined
  for (const [index, approval] of signatures.entries()) {
    if (!isPrimitiveEnvelope(approval.type)) return false
    // A quorum must end at the last approval.
    if (index > 0 && weight >= threshold) return false
    const owner = SignatureEnvelope.extractAddress({ payload: digest, signature: approval })
    if (!SignatureEnvelope.verify(approval, { address: owner, payload: digest })) return false
    const entry = config.owners.find((candidate) => TempoAddress.isEqual(candidate.owner, owner))
    if (!entry) return false
    const ownerWeight = Number(entry.weight)
    if (ownerWeight === 0) return false
    const current = BigInt(owner)
    if (previous !== undefined && previous >= current) return false
    previous = current
    weight += ownerWeight
    minWeight = minWeight === undefined ? ownerWeight : Math.min(minWeight, ownerWeight)
  }
  if (signatures.length === 0 || weight < threshold) return false
  // Dropping the lightest approval must fall below the threshold.
  if (minWeight !== undefined && weight >= threshold + minWeight) return false
  return true
}

/**
 * Verifies a TIP-1107 configurable account signature of `account` over `payload` against a config
 * commitment: the signature must name `account`, and its config must hash to `commitment` or,
 * when `commitment` is zero or missing, be the version-zero config that derives `account`.
 */
export function verify(
  envelope: SignatureEnvelope.Configurable,
  parameters: {
    /** Account the signature must authorize. */
    account: Address.Address
    /** Config commitment the signature's config must match; zero or missing for none. */
    commitment: Hex.Hex | undefined
    /** Signed 32-byte payload. */
    payload: Hex.Hex
  },
): boolean {
  const { account, commitment, payload } = parameters
  if (!TempoAddress.isEqual(envelope.account, account)) return false
  // TIP-1107 forbids an account owning itself only in its version-zero config; a later config, such
  // as a TIP-1113 upgrade that keeps the original key, may list it.
  if (
    BigInt(envelope.config.version ?? 0n) === 0n &&
    envelope.config.owners.some(({ owner }) => TempoAddress.isEqual(owner, envelope.account))
  )
    return false
  if (isZeroCommitment(commitment)) {
    if (BigInt(envelope.config.version ?? 0n) !== 0n) return false
    if (!TempoAddress.isEqual(AccountConfig.getAddress(envelope.config), account)) return false
  } else if (
    AccountConfig.getCommitment(envelope.config).toLowerCase() !== commitment!.toLowerCase()
  )
    return false
  return verifyApprovals(envelope, payload)
}
