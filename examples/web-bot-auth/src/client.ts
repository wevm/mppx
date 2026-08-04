import * as Attestation from 'mppx/attestation'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'

export type BotIdentity = {
  keyId: string
  privateKey: CryptoKey
  signatureAgent: string
}

/** Creates a Web Bot Auth request signer for one registered bot identity. */
export function createBotSigner(identity: BotIdentity) {
  return WebBotAuth.Client.signer({
    key: identity.privateKey,
    keyId: identity.keyId,
    signatureAgent: identity.signatureAgent,
  })
}

/** Wraps fetch so each HTTP attempt carries a fresh Web Bot Auth signature. */
export function createBotFetch(identity: BotIdentity): typeof globalThis.fetch {
  return Attestation.Client.wrapFetch(globalThis.fetch, createBotSigner(identity))
}

/** Computes the RFC 7638 SHA-256 thumbprint used as an Ed25519 bot key ID. */
export async function jwkThumbprint(publicKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
    throw new TypeError('Expected an extractable Ed25519 public key.')

  const canonicalJwk = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk))
  return Buffer.from(digest).toString('base64url')
}
