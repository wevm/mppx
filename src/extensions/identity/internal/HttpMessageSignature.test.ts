import { describe, expect, test } from 'vp/test'
import { keyPair, rsaKeyPair } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import { Algorithms, Headers } from '../Constants.js'
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

test('rejects non-ASCII signed HTTP header values', async () => {
  const keys = await keyPair()
  await expect(
    HttpMessageSignature.sign(
      new Request('https://example.com', { headers: { 'X-Example': 'café' } }),
      {
        components: ['x-example'],
        key: keys.privateKey,
        keyId: 'test-key',
        label: 'test',
        tag: 'test',
      },
    ),
  ).rejects.toThrow('Signed HTTP header "x-example" is not ASCII.')
})

describe('external signers', () => {
  const context = { created: Math.floor(Date.now() / 1_000) - 1, nonce: 'external-signer-nonce' }
  const signOptions = {
    components: ['@authority', '@path'],
    context,
    keyId: 'remote',
    label: 'test',
    tag: 'test',
  } as const

  function ed25519Signer(privateKey: CryptoKey, calls: Uint8Array[] = []) {
    return {
      algorithm: Algorithms.ed25519,
      async sign(bytes: Uint8Array) {
        calls.push(bytes)
        return new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes.slice()))
      },
    }
  }

  function rsaSigner(privateKey: CryptoKey, saltLength = 64) {
    return {
      algorithm: Algorithms.rsaPssSha512,
      async sign(bytes: Uint8Array) {
        return new Uint8Array(
          await crypto.subtle.sign({ name: 'RSA-PSS', saltLength }, privateKey, bytes.slice()),
        )
      },
    }
  }

  function verify(request: Request, publicKey: CryptoKey) {
    return HttpMessageSignature.verify(request, {
      keyResolver: () => publicKey,
      maxAge: 3_600,
      nonceNamespace: 'external',
      nonceStore: Store.memory(),
      requiredComponents: ['@authority', '@path'],
      tag: 'test',
    })
  }

  test('produces the same headers as the local Ed25519 key', async () => {
    // Ed25519 is deterministic, so the same key and signature base give identical bytes.
    const keys = await keyPair()
    const request = new Request('https://merchant.example/resource')
    const local = await HttpMessageSignature.sign(request, { ...signOptions, key: keys.privateKey })
    const remote = await HttpMessageSignature.sign(request, {
      ...signOptions,
      key: ed25519Signer(keys.privateKey),
    })
    expect(remote.headers.get(Headers.signatureInput)).toBe(
      local.headers.get(Headers.signatureInput),
    )
    expect(remote.headers.get(Headers.signature)).toBe(local.headers.get(Headers.signature))
    expect(await verify(remote, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('passes the complete UTF-8 signature base to the signer once', async () => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, key: ed25519Signer(keys.privateKey, calls) },
    )
    expect(calls).toHaveLength(1)
    const input = signed.headers.get(Headers.signatureInput)!.replace(/^test=/, '')
    expect(new TextDecoder().decode(calls[0])).toBe(
      [
        '"@authority": merchant.example',
        '"@path": /resource',
        '"@signature-params": ' + input,
      ].join('\n'),
    )
  })

  test('declares the signer algorithm in the signature parameters', async () => {
    const keys = await rsaKeyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, key: rsaSigner(keys.privateKey) },
    )
    expect(signed.headers.get(Headers.signatureInput)).toContain(';alg="rsa-pss-sha512";')
    expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('signs with an external RSA-PSS SHA-512 key', async () => {
    const keys = await rsaKeyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, context: undefined, key: rsaSigner(keys.privateKey) },
    )
    expect(
      await HttpMessageSignature.verify(signed, {
        keyResolver: ({ algorithm }) => {
          expect(algorithm).toBe(Algorithms.rsaPssSha512)
          return keys.publicKey
        },
        maxAge: 60,
        nonceNamespace: 'remote-rsa',
        nonceStore: Store.memory(),
        requiredComponents: ['@authority'],
        tag: 'test',
      }),
    ).toMatchObject({ status: 'verified' })
  })

  test('an RSA signer with the wrong salt length fails verification', async () => {
    const keys = await rsaKeyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, key: rsaSigner(keys.privateKey, 32) },
    )
    expect(await verify(signed, keys.publicKey)).toEqual({
      reason: 'The HTTP message signature is invalid.',
      status: 'invalid',
    })
  })

  test('a signature from another key fails verification', async () => {
    const [signing, trusted] = await Promise.all([keyPair(), keyPair()])
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, key: ed25519Signer(signing.privateKey) },
    )
    expect(await verify(signed, trusted.publicKey)).toEqual({
      reason: 'The HTTP message signature is invalid.',
      status: 'invalid',
    })
  })

  test('calls a class-based signer as a method', async () => {
    const keys = await keyPair()
    class KmsSigner {
      readonly algorithm = Algorithms.ed25519
      readonly #key = keys.privateKey
      async sign(bytes: Uint8Array) {
        return new Uint8Array(await crypto.subtle.sign('Ed25519', this.#key, bytes.slice()))
      }
    }
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      { ...signOptions, key: new KmsSigner() },
    )
    expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('accepts a signature returned as a view into a larger buffer', async () => {
    const keys = await keyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      {
        ...signOptions,
        key: {
          algorithm: Algorithms.ed25519,
          async sign(bytes) {
            const signature = await ed25519Signer(keys.privateKey).sign(bytes)
            const padded = new Uint8Array(signature.length + 16).fill(0xff)
            padded.set(signature, 8)
            return padded.subarray(8, 8 + signature.length)
          },
        },
      },
    )
    expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('accepts a Node.js Buffer', async () => {
    const keys = await keyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      {
        ...signOptions,
        key: {
          algorithm: Algorithms.ed25519,
          async sign(bytes) {
            return Buffer.from(await ed25519Signer(keys.privateKey).sign(bytes))
          },
        },
      },
    )
    expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('keeps the signature when the signer reuses its buffer afterwards', async () => {
    const keys = await keyPair()
    let returned: Uint8Array | undefined
    const signer = {
      algorithm: Algorithms.ed25519,
      async sign(bytes: Uint8Array) {
        returned = await ed25519Signer(keys.privateKey).sign(bytes)
        return returned
      },
    }
    const local = await HttpMessageSignature.sign(new Request('https://merchant.example/a'), {
      ...signOptions,
      key: keys.privateKey,
    })
    const remote = await HttpMessageSignature.sign(new Request('https://merchant.example/a'), {
      ...signOptions,
      key: signer,
    })
    returned!.fill(0)
    expect(remote.headers.get(Headers.signature)).toBe(local.headers.get(Headers.signature))
  })

  test('cannot change the signature base by mutating the bytes it was given', async () => {
    const keys = await keyPair()
    const signed = await HttpMessageSignature.sign(
      new Request('https://merchant.example/resource'),
      {
        ...signOptions,
        key: {
          algorithm: Algorithms.ed25519,
          async sign(bytes) {
            const signature = await ed25519Signer(keys.privateKey).sign(bytes)
            bytes.fill(0)
            return signature
          },
        },
      },
    )
    expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
  })

  test('keeps existing signatures on the request', async () => {
    const [first, second] = await Promise.all([keyPair(), keyPair()])
    const once = await HttpMessageSignature.sign(new Request('https://merchant.example/r'), {
      ...signOptions,
      key: first.privateKey,
      label: 'first',
    })
    const twice = await HttpMessageSignature.sign(once, {
      ...signOptions,
      key: ed25519Signer(second.privateKey),
      label: 'second',
    })
    const signature = twice.headers.get(Headers.signature)!
    expect(signature).toMatch(/^first=:[^:]+:, second=:[^:]+:$/)
    expect(signature.startsWith(once.headers.get(Headers.signature)!)).toBe(true)
  })

  test('rejects unsupported external algorithms before calling the signer', async () => {
    let called = false
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: {
          // JavaScript callers can supply unsupported algorithms despite the type.
          algorithm: 'hmac-sha256' as typeof Algorithms.ed25519,
          async sign() {
            called = true
            return new Uint8Array(64)
          },
        },
      }),
    ).rejects.toThrow('HTTP message signatures require an Ed25519 or RSA-PSS SHA-512 signing key.')
    expect(called).toBe(false)
  })

  test.each([
    ['a plain object without sign', {}],
    ['an object whose sign is not a function', { algorithm: Algorithms.ed25519, sign: 'x' }],
    ['null', null],
  ])('rejects %s as the key', async (_, key) => {
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: key as never,
      }),
    ).rejects.toThrow('HTTP message signatures require an Ed25519 or RSA-PSS SHA-512 signing key.')
  })

  test.each([
    ['a base64 string', 'c2lnbmF0dXJl'],
    ['an ArrayBuffer', new ArrayBuffer(64)],
    ['a number array', Array.from({ length: 64 }, () => 1)],
    ['undefined', undefined],
  ])('rejects %s from the signer', async (_, value) => {
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: { algorithm: Algorithms.ed25519, sign: async () => value as never },
      }),
    ).rejects.toThrow('External signer must resolve with the raw signature as a Uint8Array.')
  })

  test.each([0, 63, 65, 72])('rejects a %i-byte Ed25519 signature', async (length) => {
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: { algorithm: Algorithms.ed25519, sign: async () => new Uint8Array(length) },
      }),
    ).rejects.toThrow(
      'External Ed25519 signer returned ' + length + ' bytes; an Ed25519 signature is 64 bytes.',
    )
  })

  test('rejects an empty RSA-PSS signature', async () => {
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: { algorithm: Algorithms.rsaPssSha512, sign: async () => new Uint8Array() },
      }),
    ).rejects.toThrow('External signer returned an empty signature.')
  })

  test('propagates a signer failure', async () => {
    const failure = new Error('KMS unavailable.')
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: {
          algorithm: Algorithms.ed25519,
          sign: async () => {
            throw failure
          },
        },
      }),
    ).rejects.toBe(failure)
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
    nonceStore: Store.memory(),
    requiredComponents: [
      HttpMessageSignature.Constants.components.authority,
      HttpMessageSignature.Constants.components.signatureAgent,
    ],
    tag: 'web-bot-auth',
  })
}
