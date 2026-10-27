/** Generates an extractable Ed25519 key pair for request-attestation tests. */
export async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
}

/** Generates an extractable RSA-PSS SHA-512 key pair for request-attestation tests. */
export async function rsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      hash: 'SHA-512',
      modulusLength: 2_048,
      name: 'RSA-PSS',
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
}

/** Independently computes the RFC 7638 thumbprint used by Web Bot Auth tests. */
export async function jwkThumbprint(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key)
  let canonical: string
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x)
    canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  else if (jwk.kty === 'RSA' && jwk.e && jwk.n)
    canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })
  else throw new TypeError('Expected an Ed25519 or RSA public key.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Buffer.from(digest).toString('base64url')
}
