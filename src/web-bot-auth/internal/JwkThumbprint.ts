import { Base64 } from 'ox'

const pattern = /^[A-Za-z0-9_-]{43}$/

/** Returns whether a value has the RFC 7638 SHA-256 thumbprint encoding. */
export function is(value: string): boolean {
  return pattern.test(value)
}

/** Derives an RFC 7638 thumbprint from an extractable Ed25519 public key. */
export async function fromKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key)
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
    throw new TypeError('Web Bot Auth requires an Ed25519 public key.')
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Base64.fromBytes(new Uint8Array(digest), { pad: false, url: true })
}
