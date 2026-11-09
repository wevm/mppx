// The email worker: a minimal MPP identity issuer running in the same Worker.
//
//   POST /issuer/email/otp             {email, audience} -> emails an 8-digit code: {id, expires_at}
//   POST /issuer/email/verify          {id, code}        -> {attestation, expires_at}
//   GET  /issuer/.well-known/jwks.json                   -> the key attestations verify with
//
// It speaks the same protocol as tempoxyz/tempo-apps apps/mpp-identity, so
// `EmailOtp.Client.prover` and the curl flow work against either. Attestations are
// signed with `Attestation.sign` from mppx. Without an `EMAIL` binding, codes go to
// a demo inbox the page shows instead of being emailed.
import * as Attestation from 'mppx/extensions/identity/attestation'

import type { Trace } from './trace.js'

/** What the issuer needs from the Worker's environment. */
export type Env = {
  /** Ed25519 private key as a JWK (JSON), from `pnpm keygen`. */
  ISSUER_PRIVATE_KEY: string
  /** Cloudflare Email Service binding. Optional: without it codes go to the demo inbox. */
  EMAIL?: { send(message: Record<string, string>): Promise<unknown> } | undefined
  /** Sender address for EMAIL. */
  EMAIL_FROM?: string | undefined
}

/** Where pending codes live: a key-value store such as the mppx Durable Object store. */
export type Store = {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

type Code = {
  codeHash: string
  email: string
  audience: string
  expiresAt: number
  attempts: number
  /** Demo inbox only: the message that would have been emailed. */
  inbox?: { to: string; subject: string; text: string; code: string } | undefined
}

const codeTtl = 10 * 60 * 1000
const maxAttempts = 5
const attestationTtl = 60 * 60
/** Codes per address per 10 minutes. */
const sendLimit = 3

/** Path prefix of the issuer, so its URL is `<origin>/issuer`. */
export const path = '/issuer'

/** The issuer's signing key, its public JWK and key ID (RFC 7638 thumbprint). */
type Keys = {
  keyId: string
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: { crv: string; kty: string; x: string }
}
let keys: Promise<Keys> | undefined

/** Loads the issuer's key once per isolate. */
export function key(env: Env): Promise<Keys> {
  keys ??= (async () => {
    // Only the key material: runtimes disagree on the "alg" an Ed25519 JWK carries.
    const { crv, d, kty, x } = JSON.parse(env.ISSUER_PRIVATE_KEY) as JsonWebKey
    const publicJwk = { crv: 'Ed25519', kty: 'OKP', x: x! }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { crv, d, kty, x },
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, [
      'verify',
    ])
    // RFC 7638: the SHA-256 of the required members in lexicographic order.
    const keyId = base64url(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(publicJwk))),
    )
    return { keyId, privateKey, publicKey, publicJwk }
  })()
  return keys
}

/**
 * Resolves the issuer's key without a network round trip: the verifier and the issuer
 * share this Worker, and a Worker cannot fetch its own workers.dev URL.
 */
export function keyResolver(env: Env): Attestation.KeyResolver {
  return async ({ keyId }) => {
    const { keyId: id, publicKey } = await key(env)
    return keyId === id ? publicKey : undefined
  }
}

/** Handles an issuer request, or returns `undefined` for another path. */
export async function handle(
  request: Request,
  parameters: { env: Env; issuer: string; store: Store; trace: Trace },
): Promise<Response | undefined> {
  const { env, issuer, store, trace } = parameters
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === `${path}/.well-known/jwks.json`) {
    const { keyId, publicJwk } = await key(env)
    return Response.json({ keys: [{ ...publicJwk, alg: 'EdDSA', kid: keyId, use: 'sig' }] })
  }

  if (request.method === 'POST' && url.pathname === `${path}/email/otp`) {
    const body = await json(request)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const audience =
      typeof body.audience === 'string' && URL.canParse(body.audience)
        ? new URL(body.audience).origin
        : ''
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
      return Response.json({ error: 'Invalid email address.' }, { status: 400 })
    if (!audience) return Response.json({ error: 'Invalid audience.' }, { status: 400 })

    // step: issuer.otp
    const sent = ((await store.get(`sent:${email}`)) as number[] | null) ?? []
    const recent = sent.filter((at) => at > Date.now() - codeTtl)
    if (recent.length >= sendLimit)
      return Response.json({ error: 'Too many codes. Try again later.' }, { status: 429 })
    await store.put(`sent:${email}`, [...recent, Date.now()])

    const id = base64url(crypto.getRandomValues(new Uint8Array(16)))
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000).padStart(
      8,
      '0',
    )
    const host = new URL(audience).host
    const message = {
      to: email,
      subject: `Your verification code for ${host}`,
      text: `Your verification code for ${host} is: ${code}\n\nIt expires in 10 minutes.`,
    }
    const record: Code = {
      attempts: 0,
      audience,
      codeHash: await hash(id + code),
      email,
      expiresAt: Date.now() + codeTtl,
    }
    // step: issuer.email
    if (env.EMAIL && env.EMAIL_FROM) {
      await env.EMAIL.send({ ...message, from: env.EMAIL_FROM })
      trace.step('issuer.email', `emailed a code to ${email}`)
    } else {
      record.inbox = { ...message, code }
      trace.step('issuer.email', `demo inbox: code for ${email}`)
    }
    await store.put(`otp:${id}`, record)
    trace.step('issuer.otp', `code request ${id.slice(0, 6)}… for ${host}`)
    return Response.json({ id, expires_at: new Date(record.expiresAt).toISOString() })
  }

  if (request.method === 'POST' && url.pathname === `${path}/email/verify`) {
    const body = await json(request)
    const id = typeof body.id === 'string' ? body.id : ''
    const code = typeof body.code === 'string' ? body.code : ''
    const record = id ? ((await store.get(`otp:${id}`)) as Code | null) : null
    const invalid = () => Response.json({ error: 'Invalid or expired code.' }, { status: 400 })
    if (!record || record.expiresAt < Date.now() || record.attempts >= maxAttempts) return invalid()
    if ((await hash(id + code)) !== record.codeHash) {
      await store.put(`otp:${id}`, { ...record, attempts: record.attempts + 1 })
      trace.step('issuer.verify', 'wrong code')
      return invalid()
    }
    await store.delete(`otp:${id}`)
    trace.step('issuer.verify', `code accepted for ${record.email}`)

    // step: issuer.sign
    const { keyId, privateKey } = await key(env)
    const iat = Math.floor(Date.now() / 1000)
    const attestation = await Attestation.sign(
      {
        aud: record.audience,
        exp: iat + attestationTtl,
        iat,
        iss: issuer,
        jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
        sub: record.email,
        type: 'email',
      },
      { key: privateKey, keyId },
    )
    trace.step('issuer.sign', `signed an email attestation for ${record.audience}`)
    return Response.json({
      attestation,
      expires_at: new Date((iat + attestationTtl) * 1000).toISOString(),
    })
  }

  return undefined
}

/** The demo inbox message for a pending code request, while it is pending. */
export async function inbox(store: Store, id: string) {
  const record = (await store.get(`otp:${id}`)) as Code | null
  if (!record?.inbox || record.expiresAt < Date.now()) return undefined
  return record.inbox
}

async function json(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text()
    if (text.length > 4096) return {}
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

async function hash(value: string) {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function base64url(bytes: ArrayBuffer | Uint8Array) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
