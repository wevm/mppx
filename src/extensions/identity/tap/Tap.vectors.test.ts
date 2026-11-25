import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vp/test'

import * as Store from '../../../Store.js'
import * as HttpMessageSignature from '../internal/HttpMessageSignature.js'
import * as Tap from './index.js'

/**
 * RFC 9421 TAP vectors in tap.json. Keys are RFC 9421
 * Appendix B test keys (plus a P-384 test key); signatures were made with node:crypto, not mppx.
 */
const fixture = JSON.parse(
  readFileSync(new URL('../../../../test/fixtures/identity/tap.json', import.meta.url), 'utf8'),
) as Fixture

type Vector = {
  alg: string
  keyid: string
  name: string
  request: { method: string; url: string }
  signature: string
  signatureBase?: string
  signatureInput: string
}

type Fixture = {
  created: number
  invalid?: (Vector & { reason: string })[]
  keys: Record<string, { privateKey: JsonWebKey; publicKey: JsonWebKey }>
  vectors: Vector[]
}

const parameters = {
  ed25519: { name: 'Ed25519' },
  'ecdsa-p256-sha256': { name: 'ECDSA', namedCurve: 'P-256' },
  'ecdsa-p384-sha384': { name: 'ECDSA', namedCurve: 'P-384' },
  'rsa-pss-sha512': { name: 'RSA-PSS', hash: 'SHA-512' },
} as Record<string, AlgorithmIdentifier>

const signing = {
  ed25519: { name: 'Ed25519' },
  'ecdsa-p256-sha256': { name: 'ECDSA', hash: 'SHA-256' },
  'ecdsa-p384-sha384': { name: 'ECDSA', hash: 'SHA-384' },
  'rsa-pss-sha512': { name: 'RSA-PSS', saltLength: 64 },
} as Record<string, AlgorithmIdentifier>

async function keys(keyid: string, alg: string): Promise<CryptoKeyPair> {
  const { privateKey, publicKey } = fixture.keys[keyid]!
  return {
    privateKey: await crypto.subtle.importKey('jwk', privateKey, parameters[alg]!, true, ['sign']),
    publicKey: await crypto.subtle.importKey('jwk', publicKey, parameters[alg]!, true, ['verify']),
  }
}

function request(vector: Vector) {
  return new Request(vector.request.url, {
    headers: { 'Signature-Input': vector.signatureInput, Signature: vector.signature },
    method: vector.request.method,
  })
}

async function verify(vector: Vector) {
  const { publicKey } = await keys(vector.keyid, vector.alg ?? 'ed25519')
  return Tap.Server.verifier({
    keyResolver: ({ keyId }) => (keyId === vector.keyid ? publicKey : undefined),
    nonceStore: Store.memory(),
  }).verify(request(vector))
}

beforeEach(() => {
  vi.useFakeTimers({ now: (fixture.created + 1) * 1_000, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe.each(fixture.vectors)('$name', (vector) => {
  test('verifies', async () => {
    expect(await verify(vector)).toMatchObject({ status: 'valid', value: { keyId: vector.keyid } })
  })

  test('signs the same signature base and Signature-Input', async () => {
    const pair = await keys(vector.keyid, vector.alg)
    const payloads: Uint8Array[] = []
    const components = vector.signatureInput.slice(
      'tap=('.length,
      vector.signatureInput.indexOf(')'),
    )
    const nonce = /;nonce="([^"]+)"/.exec(vector.signatureInput)![1]!
    const tag = /;tag="([^"]+)"/.exec(vector.signatureInput)![1]!
    const signed = await HttpMessageSignature.sign(
      new Request(vector.request.url, { method: vector.request.method }),
      {
        components: components.split(' ').map((component) => component.slice(1, -1)),
        context: { created: fixture.created, nonce },
        expiresIn: 480,
        key: {
          publicKey: pair.publicKey,
          async sign({ payload }) {
            payloads.push(payload)
            return new Uint8Array(
              await crypto.subtle.sign(signing[vector.alg]!, pair.privateKey, payload.slice()),
            )
          },
        },
        keyId: vector.keyid,
        label: 'tap',
        tag,
      },
    )
    expect(new TextDecoder().decode(payloads[0])).toBe(vector.signatureBase)
    expect(signed.headers.get('Signature-Input')).toBe(vector.signatureInput)
    // Ed25519 is deterministic, so the signature itself must match too.
    if (vector.alg === 'ed25519') expect(signed.headers.get('Signature')).toBe(vector.signature)
  })
})

describe.each(fixture.invalid ?? [])('rejects: $name', (vector) => {
  test('with its reason', async () => {
    expect(await verify({ ...vector, alg: 'ed25519' })).toEqual({
      reason: vector.reason,
      status: 'invalid',
    })
  })
})
