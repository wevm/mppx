import { describe, expect, test } from 'vp/test'

import { Algorithms, Headers } from '../Constants.js'
import * as NonceStore from '../NonceStore.js'
import * as HttpMessageSignature from './HttpMessageSignature.js'

const signatureAgent = 'agent2="https://signature-agent.test"'
const maximumVectorLifetime = 3_153_600_000

describe('Web Bot Auth draft test vectors', () => {
  test('verifies the Ed25519 Signature-Agent vector', async () => {
    const key = await crypto.subtle.importKey(
      'jwk',
      {
        crv: 'Ed25519',
        kty: 'OKP',
        x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
      },
      'Ed25519',
      true,
      ['verify'],
    )
    const request = vectorRequest({
      input:
        'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
      signature:
        'sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:',
    })

    expect(await verifyVector(request, key)).toMatchObject({ status: 'verified' })
  })

  test('verifies the RSA-PSS SHA-512 Signature-Agent vector', async () => {
    const spki = Buffer.from(
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr4tmm3r20Wd/PbqvP1s2+QEtvpuRaV8Yq40gjUR8y2Rjxa6dpG2GXHbPfvMs8ct+Lh1GH45x28Rw3Ry53mm+oAXjyQ86OnDkZ5N8lYbggD4O3w6M6pAvLkhk95AndTrifbIFPNU8PPMO7OyrFAHqgDsznjPFmTOtCEcN2Z1FpWgchwuYLPL+Wokqltd11nqqzi+bJ9cvSKADYdUAAN5WUtzdpiy6LbTgSxP7ociU4Tn0g5I6aDZJ7A8Lzo0KSyZYoA485mqcO0GVAdVw9lq4aOT9v6d+nb4bnNkQVklLQ3fVAvJm+xdDOp9LCNCN48V2pnDOkFV6+U9nV5oyc6XI2wIDAQAB',
      'base64',
    )
    const key = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(spki),
      { hash: 'SHA-512', name: 'RSA-PSS' },
      true,
      ['verify'],
    )
    const request = vectorRequest({
      input:
        'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="oD0HwocPBSfpNy5W3bpJeyFGY_IQ_YpqxSjQ3Yd-CLA";alg="rsa-pss-sha512";expires=4889289600;nonce="wcfPQPh7SzkvrIVvhD00vNk9PkxJNY2NVbYl2PVBB4zmUoluSwE7W6bPtF60QA3k8g06FU7PPCD+J58YofY1zg==";tag="web-bot-auth"',
      signature:
        'sig2=:gHzpLNeHaHIO19NaJH9YMW5dcVSi2s0wOMBr6p18vcofS106sfC4KBIS0/szPlBBd1vIcyQ88B6CTEWIhRAiVrb9zfX0mx1aG12CSGWcYkSirHeyTxhbuJvXd27ed6skWoy4PjXItq38936ivUQjfdIwXh1aX6HxkAC3vRnEdSNfntkLWeEuIQ5BLIOBGE39fSwg27Qjq6OVWYas/9/aFUr3HA34MXWYdp+//cvlEKDp3kRoLOw9ro0AOr6srHrTeEtxon2afcws1aZVSlPdd2fZSEIGmw9HAHLDCEkFTERu1gH2k/zIEqgy7CAYXI9E5slog0cLg/Vc6+f8gih33g==:',
    })

    expect(await verifyVector(request, key)).toMatchObject({ status: 'verified' })
  })
})

function vectorRequest(parameters: { input: string; signature: string }): Request {
  return new Request('https://example.com/foo?param=Value&Pet=dog', {
    headers: {
      [Headers.signature]: parameters.signature,
      [Headers.signatureInput]: parameters.input,
      'Signature-Agent': signatureAgent,
    },
    method: 'POST',
  })
}

function verifyVector(request: Request, key: CryptoKey) {
  return HttpMessageSignature.verify(request, {
    keyResolver({ algorithm }) {
      expect(algorithm).toBe(
        key.algorithm.name === 'Ed25519' ? Algorithms.ed25519 : Algorithms.rsaPssSha512,
      )
      return key
    },
    maxAge: maximumVectorLifetime,
    nonceNamespace: 'web-bot-auth',
    nonceStore: NonceStore.memory(),
    requiredComponents: [
      HttpMessageSignature.Constants.components.authority,
      HttpMessageSignature.Constants.components.signatureAgent,
    ],
    tag: 'web-bot-auth',
  })
}
