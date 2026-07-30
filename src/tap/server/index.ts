import { Capabilities } from '../../attestation/Constants.js'
import * as HttpMessageSignature from '../../attestation/internal/HttpMessageSignature.js'
import * as Attestation from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a verifier for TAP agent-recognition signatures.
 *
 * TAP verifies trusted agent participation and request integrity. Consumer
 * recognition and payment-container verification stay protocol-specific and
 * are intentionally not inferred from this header-only verifier.
 */
export function verifier(config: verifier.Config): Attestation.Verifier<Types.Evidence> {
  const nonceStore = config.nonceStore ?? HttpMessageSignature.createNonceStore()
  return {
    async verify(request) {
      const result = await HttpMessageSignature.verify(request, {
        keyResolver: config.keyResolver,
        maxAge: Constants.maximumSignatureLifetime,
        nonceStore,
        requiredComponents: Constants.requiredComponents,
        tag: [Constants.tags.browse, Constants.tags.payment],
      })
      if (!result.input)
        return result.reason ? { status: 'invalid', reason: result.reason } : { status: 'absent' }
      return {
        status: 'verified',
        evidence: {
          protocol: Constants.protocol,
          capabilities: [
            Capabilities.agentIdentity,
            Capabilities.requestBinding,
            Capabilities.replayProtection,
            Capabilities.commerceIntent,
          ],
          value: {
            keyId: result.input.keyId,
            nonce: result.input.nonce,
            intent:
              result.input.tag === Constants.tags.payment
                ? Constants.intents.payment
                : Constants.intents.browse,
          },
        },
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Resolves a TAP-approved public key by its `keyid` parameter. */
    keyResolver: HttpMessageSignature.KeyResolver
    /** Atomically consumes each nonce in shared storage for multi-instance deployments. */
    nonceStore?: HttpMessageSignature.NonceStore | undefined
  }
}
