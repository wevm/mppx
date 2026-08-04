import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Mppx } from 'mppx/client'

import { clientMethod } from './method.js'

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

/** Creates a payment-aware MPP client that signs every HTTP attempt with Web Bot Auth. */
export function createBotClient(identity: BotIdentity) {
  return Mppx.create({
    attestation: { webBotAuth: createBotSigner(identity) },
    methods: [clientMethod],
    polyfill: false,
  })
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
