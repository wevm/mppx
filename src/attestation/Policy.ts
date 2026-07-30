import type * as Types from './Types.js'

/** Returns whether any verified protocol supplied a required capability. */
export function hasCapability(
  evidence: readonly Types.Evidence[],
  capability: Types.Capability,
): boolean {
  return evidence.some((entry) => entry.capabilities.includes(capability))
}

/** Creates a policy requiring all listed capabilities from one or more verified protocols. */
export function requireCapabilities(
  capabilities: readonly Types.Capability[],
): Types.RequestPolicy {
  return ({ evidence }) => {
    const missing = capabilities.filter((capability) => !hasCapability(evidence, capability))
    return missing.length === 0
      ? { allow: true }
      : { allow: false, reason: `Missing required attestation: ${missing.join(', ')}.` }
  }
}
