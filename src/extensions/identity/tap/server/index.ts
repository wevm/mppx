import type * as Identity from '../../../../identity/Types.js'
import type * as Store from '../../../../Store.js'
import * as HttpMessageSignature from '../../internal/HttpMessageSignature.js'
import * as Verification from '../../internal/Verification.js'
import type * as SignatureTypes from '../../Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a request-stage identity verifier for TAP agent-recognition signatures.
 *
 * TAP verifies trusted agent participation and request integrity. Consumer
 * recognition and payment-container verification stay protocol-specific and
 * are intentionally not inferred from this header-only verifier.
 *
 * @example
 * ```ts
 * const tap = Tap.Server.verifier({ keyResolver, nonceStore })
 * mppx.charge({ amount: '1', identity: [tap] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedRequest> {
  return {
    stage: 'request',
    async verify(request) {
      const result = await HttpMessageSignature.verify(request, {
        keyResolver: config.keyResolver,
        maxAge: Constants.maximumSignatureLifetime,
        nonceNamespace: Constants.protocol,
        nonceStore: config.nonceStore,
        requiredComponents: Constants.requiredComponents,
        tag: [Constants.tags.browse, Constants.tags.payment],
      })
      if (result.status !== 'verified') return Verification.fromSignature(result)
      return {
        status: 'valid',
        value: {
          keyId: result.input.keyId,
          nonce: result.input.nonce,
          intent:
            result.input.tag === Constants.tags.payment
              ? Constants.intents.payment
              : Constants.intents.browse,
        },
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Resolves a TAP-approved public key by its `keyid` and signature algorithm. */
    keyResolver: SignatureTypes.KeyResolver
    /** Atomically consumes each nonce in shared storage for multi-instance deployments. */
    nonceStore: Store.AtomicStore
  }
}
