import { Base64 } from 'ox'

import type * as Jwt from '../../tempo/internal/Jwt.js'

/** Signs a compact ES256 JWS. */
export async function sign(header: object, claims: object, privateKey: CryptoKey) {
  const input = `${encode(header)}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
}

/** Verifies a decoded JWS with a public JWK, for `ES256` or `PS384` only. */
export async function verify(jws: Jwt.Decoded, jwk: JsonWebKey, algs: readonly string[]) {
  const alg = jws.header.alg
  if (!algs.includes(alg)) return false
  try {
    if (alg === 'ES256') {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false
      const { crv, kty, x, y } = jwk
      const key = await crypto.subtle.importKey(
        'jwk',
        { crv, kty, x, y } as JsonWebKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        jws.signature,
        jws.signingInput,
      )
    }
    if (jwk.kty !== 'RSA') return false
    const { e, kty, n } = jwk
    const key = await crypto.subtle.importKey(
      'jwk',
      { e, kty, n } as JsonWebKey,
      { name: 'RSA-PSS', hash: 'SHA-384' },
      false,
      ['verify'],
    )
    return crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 48 },
      key,
      jws.signature,
      jws.signingInput,
    )
  } catch {
    return false
  }
}

/**
 * The OAuth access token a request carries as `Bearer` or `DPoP` (a Payment Credential is not
 * one), `undefined` without one, or `null` when `Authorization` names one of those schemes in any
 * other form, such as several combined values, so it can't skip the `ath` binding.
 */
export function accessToken(headers: Headers): string | null | undefined {
  const value = headers.get('Authorization')?.trim()
  if (!value) return undefined
  const match = /^(?:bearer|dpop)[ \t]+([^\s,"]+)$/i.exec(value)
  if (match) return match[1]
  // Quoted auth-param values can contain anything, so a scheme name inside one doesn't count.
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  return /(?:^|,)\s*(?:bearer|dpop)(?:\s|$)/i.test(unquoted) ? null : undefined
}

function encode(value: unknown) {
  return Base64.fromString(JSON.stringify(value), { pad: false, url: true })
}
