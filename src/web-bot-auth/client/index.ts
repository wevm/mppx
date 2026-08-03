import { parseDictionary, serializeDictionary } from 'structured-headers'
import type { Dictionary } from 'structured-headers'

import * as Attestation from '../../attestation/Client.js'
import * as HttpMessageSignature from '../../attestation/internal/HttpMessageSignature.js'
import type * as AttestationTypes from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import * as JwkThumbprint from '../internal/JwkThumbprint.js'
import * as SignatureAgent from '../internal/SignatureAgent.js'

/**
 * Creates a Web Bot Auth request signer.
 *
 * The signed `Signature-Agent` header links the request to the HTTPS origin
 * of an HTTP Message Signatures Directory. It establishes bot identity only;
 * it does not assert consumer identity or authority to make a payment.
 */
export function signer(config: signer.Config): AttestationTypes.Signer<typeof Constants.protocol> {
  const label = config.label ?? Constants.label
  const signatureAgentKey = config.signatureAgentKey ?? label
  const expiresIn = config.expiresIn ?? Constants.signatureLifetime
  const signatureAgent = SignatureAgent.directoryOrigin(config.signatureAgent)
  if (!JwkThumbprint.is(config.keyId))
    throw new TypeError('Web Bot Auth keyId must be an RFC 7638 SHA-256 JWK thumbprint.')
  if (!signatureAgent) throw new TypeError('Signature-Agent must identify a valid HTTPS origin.')
  if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > Constants.signatureLifetime)
    throw new RangeError(
      `Web Bot Auth expiresIn must be an integer from 1 to ${Constants.signatureLifetime}.`,
    )
  return {
    protocol: Constants.protocol,
    sign(request, context) {
      const headers = new Headers(request.headers)
      const signatureAgents = parseSignatureAgents(headers)
      if (signatureAgents.has(signatureAgentKey))
        throw new Error(`Signature-Agent member "${signatureAgentKey}" already exists.`)
      signatureAgents.set(signatureAgentKey, [signatureAgent, new Map()])
      headers.set(Constants.signatureAgentHeader, serializeDictionary(signatureAgents))
      return HttpMessageSignature.sign(new Request(request, { headers }), {
        components: [
          HttpMessageSignature.Constants.components.authority,
          {
            id: HttpMessageSignature.Constants.components.signatureAgent,
            parameters: new Map([['key', signatureAgentKey]]),
          },
        ],
        context,
        expiresIn,
        key: config.key,
        keyId: config.keyId,
        label,
        tag: Constants.tag,
      })
    },
  }
}

export declare namespace signer {
  type Config = {
    /** Ed25519 or RSA-PSS SHA-512 private key registered for the bot. */
    key: CryptoKey
    /** RFC 7638 JWK thumbprint for the registered public key. */
    keyId: string
    /** HTTPS directory origin, sent with the default `directory` discovery type. */
    signatureAgent: string
    /** Dictionary member name used for `Signature-Agent`. @default signature label */
    signatureAgentKey?: string | undefined
    /** Signature lifetime in seconds. @default 60 */
    expiresIn?: number | undefined
    /** RFC 9421 dictionary label. @default 'webbot' */
    label?: string | undefined
  }
}

/** Wraps a fetch implementation with a Web Bot Auth signer. */
export function wrapFetch(
  fetch: typeof globalThis.fetch,
  config: signer.Config,
): typeof globalThis.fetch {
  return Attestation.wrapFetch(fetch, signer(config))
}

function parseSignatureAgents(headers: Headers): Dictionary {
  const value = headers.get(Constants.signatureAgentHeader)
  if (!value) return new Map()
  try {
    return parseDictionary(value)
  } catch {
    throw new Error(
      `HTTP header "${Constants.signatureAgentHeader}" is not a structured dictionary.`,
    )
  }
}
