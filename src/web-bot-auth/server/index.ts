import { isInnerList, parseDictionary, Token } from 'structured-headers'

import { Capabilities } from '../../attestation/Constants.js'
import * as HttpMessageSignature from '../../attestation/internal/HttpMessageSignature.js'
import * as Attestation from '../../attestation/Types.js'
import { Constants } from '../Constants.js'
import * as JwkThumbprint from '../internal/JwkThumbprint.js'
import * as SignatureAgent from '../internal/SignatureAgent.js'
import type * as Types from '../Types.js'

/**
 * Creates a verifier for Web Bot Auth request signatures.
 *
 * Web Bot Auth confirms the cryptographic identity of an automated HTTP
 * client. It must not be used on its own as user or payment authorization.
 */
export function verifier(config: verifier.Config): Attestation.Verifier<Types.Evidence> {
  const nonceStore = config.nonceStore ?? HttpMessageSignature.createNonceStore()
  return {
    async verify(request) {
      let signatureAgent: string | undefined
      const result = await HttpMessageSignature.verify(request, {
        async keyResolver(parameters) {
          const key = await config.keyResolver({
            ...parameters,
            signatureAgent: signatureAgent!,
          })
          if (!key) return undefined
          try {
            return (await JwkThumbprint.fromKey(key)) === parameters.keyId ? key : undefined
          } catch {
            return undefined
          }
        },
        maxAge: Constants.signatureLifetime,
        nonceStore,
        requiredComponents: Constants.requiredComponents,
        tag: Constants.tag,
        validate(_input, input) {
          if (!JwkThumbprint.is(_input.keyId))
            return 'The Web Bot Auth keyid must be an RFC 7638 SHA-256 JWK thumbprint.'
          const component = _input.components.find(
            (entry) => entry.id === HttpMessageSignature.Constants.components.signatureAgent,
          )
          const key = component?.parameters?.get('key')
          if (typeof key !== 'string')
            return 'The signed Signature-Agent component must identify a dictionary member.'
          const value = input.headers.get(Constants.signatureAgentHeader)
          if (!value) return 'The Signature-Agent header is required.'
          let agents
          try {
            agents = parseDictionary(value)
          } catch {
            return 'The Signature-Agent header must be a structured dictionary.'
          }
          const agent = agents.get(key)
          if (!agent || isInnerList(agent) || typeof agent[0] !== 'string')
            return 'The signed Signature-Agent member must be an HTTPS URL.'
          const type = agent[1].get('type')
          if (type !== undefined && (!(type instanceof Token) || type.toString() !== 'directory'))
            return 'The Signature-Agent discovery type is not supported.'
          const origin = SignatureAgent.directoryOrigin(agent[0])
          if (!origin) return 'The Signature-Agent header must identify a valid HTTPS origin.'
          signatureAgent = origin
          return undefined
        },
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
          ],
          value: {
            keyId: result.input.keyId,
            nonce: result.input.nonce,
            signatureAgent: signatureAgent!,
          },
        },
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /**
     * Resolves a public key for the advertised directory.
     *
     * Apply the origin's trust policy before any network lookup; do not fetch an
     * arbitrary caller-provided `signatureAgent` URL. Returned public keys
     * must be extractable so their RFC 7638 thumbprints can be verified.
     */
    keyResolver: (parameters: {
      keyId: string
      request: Request
      signatureAgent: string
    }) => Promise<CryptoKey | undefined> | CryptoKey | undefined
    /** Atomically consumes each nonce in shared storage for multi-instance deployments. */
    nonceStore?: HttpMessageSignature.NonceStore | undefined
  }
}
