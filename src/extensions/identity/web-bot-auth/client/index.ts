import { parseDictionary, serializeDictionary } from 'structured-headers'
import type { Dictionary } from 'structured-headers'

import type * as Identity from '../../../../identity/Types.js'
import * as HttpMessageSignature from '../../internal/HttpMessageSignature.js'
import * as JwkThumbprint from '../../internal/JwkThumbprint.js'
import * as Signer from '../../internal/Signer.js'
import type { SigningKey } from '../../Types.js'
import { Constants } from '../Constants.js'
import * as SignatureAgent from '../internal/SignatureAgent.js'

/**
 * Creates a Web Bot Auth HTTPS-directory profile identity prover.
 *
 * The signed `Signature-Agent` header links the request to the HTTPS origin
 * of an HTTP Message Signatures Directory. This adapter does not support
 * direct key configuration or other Web Bot Auth discovery types. It
 * establishes bot identity only; it does not assert consumer identity or
 * authority to make a payment.
 */
export function prover(config: prover.Config): Identity.Prover {
  const label = config.label ?? Constants.label
  const signatureAgentKey = config.signatureAgentKey ?? label
  const expiresIn = config.expiresIn ?? Constants.defaultSignatureLifetime
  const signatureAgent = SignatureAgent.directoryOrigin(config.signatureAgent)
  const { publicKey } = Signer.resolve(config.key)
  let keyId: Promise<string> | undefined
  if (!signatureAgent) throw new TypeError('Signature-Agent must identify a valid HTTPS origin.')
  if (!Number.isInteger(expiresIn) || expiresIn <= 0)
    throw new RangeError('Web Bot Auth expiresIn must be a positive integer.')
  return {
    scope: config.scope,
    async prove(request, context) {
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
        // The keyid is the RFC 7638 thumbprint of the public key, so it can't disagree with it.
        keyId: await (keyId ??= JwkThumbprint.fromKey(publicKey)),
        label,
        tag: Constants.tag,
      })
    },
  }
}

export declare namespace prover {
  type Config = {
    /**
     * Ed25519 or RSA-PSS SHA-512 key pair, or a {@link SigningKey | Signer} for a remote key,
     * registered for the bot. The `keyid` is the RFC 7638 thumbprint of its public key.
     */
    key: SigningKey
    /** Origins that receive Web Bot Auth signatures, or `'*'` for any origin. */
    scope: Identity.Prover['scope']
    /** Required HTTPS directory origin, sent with the default `directory` discovery type. */
    signatureAgent: string
    /** Dictionary member name used for `Signature-Agent`. @default signature label */
    signatureAgentKey?: string | undefined
    /** Signature lifetime in seconds. @default 60 */
    expiresIn?: number | undefined
    /** RFC 9421 dictionary label. @default 'webbot' */
    label?: string | undefined
  }
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
