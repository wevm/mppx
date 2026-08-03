import type * as Types from './Types.js'

/**
 * Verifies every configured protocol and preserves every outcome alongside trusted evidence.
 *
 * Callers decide how to handle absent and unverified protocols. Middleware always rejects
 * invalid signatures before evaluating its route policy.
 */
export async function verify<const verifiers extends Types.VerifierMap>(
  request: Request,
  verifiers: verifiers,
): Promise<Types.VerificationSummary<verifiers>> {
  const evidence: Types.EvidenceFrom<verifiers>[] = []
  const outcomes: Record<string, Types.Verification> = {}
  for (const [protocol, verifier] of Object.entries(verifiers)) {
    const result = await verifier.verify(request)
    outcomes[protocol] = result
    if (result.status === 'verified')
      evidence.push(result.evidence as Types.EvidenceFrom<verifiers>)
  }
  return {
    evidence,
    outcomes: outcomes as Types.VerificationsFrom<verifiers>,
  }
}

/**
 * Applies request-attestation verification and policy before an HTTP handler.
 *
 * This wrapper deliberately runs before the wrapped MPPX handler. A route can require
 * attestation without exposing a payment challenge to an untrusted caller.
 */
export function middleware<const verifiers extends Types.VerifierMap>(
  handler: Types.RequestHandler,
  config: middleware.Config<verifiers>,
): Types.RequestHandler {
  return async (request) => {
    let verification: Types.VerificationSummary<verifiers>
    try {
      verification = await verify(request, config.verifiers)
    } catch {
      return new Response('Request attestation is invalid.', { status: 401 })
    }
    if (Object.values(verification.outcomes).some((result) => result.status === 'invalid'))
      return new Response('Request attestation is invalid.', { status: 401 })

    const decision = await config.policy({ ...verification, request })
    if (!decision.allow) return new Response(decision.reason, { status: 403 })
    return handler(request)
  }
}

export declare namespace middleware {
  /** Configuration for a typed protocol-verifier map and its authorization policy. */
  type Config<verifiers extends Types.VerifierMap> = {
    /** Verifiers keyed by the protocol name used in invalid-signature diagnostics. */
    verifiers: verifiers
    /** Policy evaluated against the exact evidence and outcomes emitted by `verifiers`. */
    policy: Types.RequestPolicy<Types.EvidenceFrom<verifiers>, Types.VerificationsFrom<verifiers>>
  }
}
