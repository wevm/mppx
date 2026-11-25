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
 * A request carrying more than one TAP signature is rejected, since it is ambiguous which one
 * identifies the agent.
 *
 * @example
 * ```ts
 * const tap = Tap.Server.verifier({
 *   keyResolver: Tap.Jwks.resolver({ url: 'https://agent-provider.example/.well-known/jwks.json' }),
 *   nonceStore: Store.redis(redis),
 *   // Bind payment requests to their method and body, beyond TAP's minimum.
 *   requiredComponents: { payment: ['@method', 'content-digest'] },
 * })
 * mppx.charge({ amount: '1', identity: [tap] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedRequest> {
  const clockSkew = config.clockSkew ?? 0
  if (!Number.isInteger(clockSkew) || clockSkew < 0 || clockSkew > Constants.maximumClockSkew)
    throw new RangeError(
      `TAP clockSkew must be an integer from 0 to ${Constants.maximumClockSkew}.`,
    )
  const extra = {
    [Constants.tags.browse]: config.requiredComponents?.browse ?? [],
    [Constants.tags.payment]: config.requiredComponents?.payment ?? [],
  }
  return {
    stage: 'request',
    async verify(request) {
      const result = await HttpMessageSignature.verify(request, {
        clockSkew,
        keyResolver: config.keyResolver,
        maxAge: Constants.maximumSignatureLifetime,
        nonceNamespace: Constants.protocol,
        // TAP blocks any nonce seen within the signature lifetime, whichever key signed it.
        nonceScope: 'namespace',
        nonceStore: config.nonceStore,
        requiredComponents: Constants.requiredComponents,
        tag: [Constants.tags.browse, Constants.tags.payment],
        unique: true,
        validate(input) {
          const required = extra[input.tag as keyof typeof extra] ?? []
          if (!required.every((id) => HttpMessageSignature.coversWholeField(input.components, id)))
            return 'The signature does not cover the components this verifier requires.'
          return undefined
        },
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
    /**
     * Resolves a TAP-approved public key by its `keyid` and signature algorithm, such as
     * `Tap.Jwks.resolver` for an agent provider's JSON Web Key Set.
     */
    keyResolver: SignatureTypes.KeyResolver
    /**
     * Atomically consumes each nonce. `Store.memory()` covers one long-lived process only: with
     * several instances, use a shared store such as `Store.redis`, `Store.upstash`,
     * `Store.durableObject` or `Store.postgres`, so a nonce one instance accepted is refused by
     * the others for the signature's lifetime.
     */
    nonceStore: Store.AtomicStore
    /**
     * Seconds the agent's clock may run ahead of or behind this server's. TAP itself allows none.
     * @default 0
     */
    clockSkew?: number | undefined
    /**
     * Components a signature must cover beyond TAP's `@authority` and `@path`, by intent. A
     * covered `content-digest` is checked against the request body.
     */
    requiredComponents?:
      | {
          /** Required on `agent-browser-auth` signatures. */
          browse?: readonly string[] | undefined
          /** Required on `agent-payer-auth` signatures, such as `['@method', 'content-digest']`. */
          payment?: readonly string[] | undefined
        }
      | undefined
  }
}
