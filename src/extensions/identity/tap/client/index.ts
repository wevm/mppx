import type * as Identity from '../../../../identity/Types.js'
import * as HttpMessageSignature from '../../internal/HttpMessageSignature.js'
import { Constants } from '../Constants.js'

/**
 * Creates a TAP identity prover.
 *
 * The prover signs each in-scope attempt, including MPP payment retries, with
 * an RFC 9421 HTTP message signature carrying TAP's `agent-browser-auth` or
 * `agent-payer-auth` tag.
 *
 * @example
 * ```ts
 * Mppx.create({ identity: [Tap.Client.prover({ intent: 'payment', key, keyId, scope: ['https://shop.example'] })], methods })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const tag =
    config.intent === Constants.intents.payment ? Constants.tags.payment : Constants.tags.browse
  const expiresIn = config.expiresIn ?? Constants.defaultSignatureLifetime
  if (
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > Constants.maximumSignatureLifetime
  )
    throw new RangeError(
      `TAP expiresIn must be an integer from 1 to ${Constants.maximumSignatureLifetime}.`,
    )
  return {
    scope: config.scope,
    prove(request, context) {
      return HttpMessageSignature.sign(request, {
        components: Constants.requiredComponents,
        context,
        expiresIn,
        key: config.key,
        keyId: config.keyId,
        label: config.label ?? Constants.label,
        tag,
      })
    },
  }
}

export declare namespace prover {
  type Config = {
    /** TAP signature type for the request. */
    intent: (typeof Constants.intents)[keyof typeof Constants.intents]
    /** Ed25519 or RSA-PSS SHA-512 private key provisioned to the agent provider. */
    key: CryptoKey
    /** Identifier the merchant uses to resolve the signing public key. */
    keyId: string
    /** Origins that receive TAP signatures, or `'*'` for any origin. */
    scope: Identity.Prover['scope']
    /** Signature lifetime in seconds. TAP permits at most eight minutes. @default 480 */
    expiresIn?: number | undefined
    /** RFC 9421 dictionary label. @default 'tap' */
    label?: string | undefined
  }
}
