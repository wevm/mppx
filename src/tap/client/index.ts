import * as HttpMessageSignature from '../../attestation/internal/HttpMessageSignature.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'

/**
 * Creates a TAP request signer.
 *
 * The signer emits RFC 9421 HTTP message signatures with TAP's
 * `agent-browser-auth` or `agent-payer-auth` tag. Pass it to
 * `Attestation.Client.wrapFetch` so MPPX signs both the initial request and
 * its automatic paid retry.
 */
export function signer(config: signer.Config): AttestationTypes.Signer<typeof Constants.protocol> {
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
    protocol: Constants.protocol,
    sign(request, context) {
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

export declare namespace signer {
  type Config = {
    /** TAP signature type for the request. */
    intent: (typeof Constants.intents)[keyof typeof Constants.intents]
    /** Ed25519 or RSA-PSS SHA-512 private key provisioned to the agent provider. */
    key: CryptoKey
    /** Identifier the merchant uses to resolve the signing public key. */
    keyId: string
    /** Signature lifetime in seconds. TAP permits at most eight minutes. @default 480 */
    expiresIn?: number | undefined
    /** RFC 9421 dictionary label. @default 'tap' */
    label?: string | undefined
  }
}
