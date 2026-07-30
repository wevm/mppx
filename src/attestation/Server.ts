import type * as Types from './Types.js'

/**
 * Verifies every configured protocol and returns only successfully verified evidence.
 *
 * A malformed protocol-specific signature rejects the request. An absent signature is
 * left to the supplied policy so routes can explicitly allow anonymous traffic.
 */
export async function verify(
  request: Request,
  verifiers: Types.VerifierMap,
): Promise<readonly Types.Evidence[]> {
  const evidence: Types.Evidence[] = []
  for (const [protocol, verifier] of Object.entries(verifiers)) {
    const result = await verifier.verify(request)
    if (result.status === 'invalid') throw new Error(`${protocol}: ${result.reason}`)
    if (result.status === 'verified') evidence.push(result.evidence)
  }
  return evidence
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
    let evidence: readonly Types.EvidenceFrom<verifiers>[]
    try {
      evidence = (await verify(
        request,
        config.verifiers,
      )) as readonly Types.EvidenceFrom<verifiers>[]
    } catch {
      return new Response('Request attestation is invalid.', { status: 401 })
    }

    const decision = await config.policy({ evidence, request })
    if (!decision.allow) return new Response(decision.reason, { status: 403 })
    return handler(request)
  }
}

export declare namespace middleware {
  /** Configuration for a typed protocol-verifier map and its authorization policy. */
  type Config<verifiers extends Types.VerifierMap> = {
    /** Verifiers keyed by the protocol name used in invalid-signature diagnostics. */
    verifiers: verifiers
    /** Policy evaluated against the exact evidence union emitted by `verifiers`. */
    policy: Types.RequestPolicy<Types.EvidenceFrom<verifiers>>
  }
}
