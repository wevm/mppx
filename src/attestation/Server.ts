import type * as Types from './Types.js'

/** Verifies every configured request-attestation protocol. */
export async function verify<const verifiers extends Types.VerifierMap>(
  request: Request,
  verifiers: verifiers,
): Promise<Types.VerificationsFrom<verifiers>> {
  const outcomes: Record<string, Types.Verification> = {}
  for (const [name, verifier] of Object.entries(verifiers))
    outcomes[name] = await verifier.verify(request)
  return outcomes as Types.VerificationsFrom<verifiers>
}
