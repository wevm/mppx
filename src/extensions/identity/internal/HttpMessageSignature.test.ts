import * as vm from 'node:vm'

import { describe, expect, test } from 'vp/test'
import { keyPair, remoteSigner, rsaKeyPair } from '~test/Identity.js'

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
        key: keys,
        keyId: 'test-key',
        label: 'test',
        tag: 'test',
      },
    ),
  ).rejects.toThrow('Signed HTTP header "x-example" is not ASCII.')
})

describe('signing keys', () => {
  const context = { created: Math.floor(Date.now() / 1_000) - 1, nonce: 'signing-key-nonce' }
  const signOptions = {
    components: ['@authority', '@path'],
    context,
    keyId: 'remote',
    label: 'test',
    tag: 'test',
  } as const
  const request = () => new Request('https://merchant.example/resource')
  const sign = (
    key: unknown,
    options: Partial<Parameters<typeof HttpMessageSignature.sign>[1]> = {},
  ) => HttpMessageSignature.sign(request(), { ...signOptions, ...options, key: key as never })

  function verify(signed: Request, publicKey: CryptoKey) {
    return HttpMessageSignature.verify(signed, {
      keyResolver: () => publicKey,
      maxAge: 3_600,
      nonceNamespace: 'signing-keys',
      nonceStore: Store.memory(),
      requiredComponents: ['@authority', '@path'],
      tag: 'test',
    })
  }

  describe('remote signers', () => {
    test('produce the same headers as the local key pair', async () => {
      // Ed25519 is deterministic, so the same key and signature base give identical bytes.
      const keys = await keyPair()
      const local = await sign(keys)
      const remote = await sign(remoteSigner(keys))
      expect(remote.headers.get(Headers.signatureInput)).toBe(
        local.headers.get(Headers.signatureInput),
      )
      expect(remote.headers.get(Headers.signature)).toBe(local.headers.get(Headers.signature))
      expect(await verify(remote, keys.publicKey)).toMatchObject({ status: 'verified' })
    })

    test('get the complete UTF-8 signature base, once', async () => {
      const keys = await keyPair()
      const calls: Uint8Array[] = []
      const signed = await sign(remoteSigner(keys, { calls }))
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

    test.each([
      ['Ed25519', keyPair, 'ed25519'],
      ['RSA-PSS SHA-512', rsaKeyPair, 'rsa-pss-sha512'],
    ] as const)('take the %s algorithm from the public key', async (_, generate, alg) => {
      const keys = await generate()
      const signed = await sign(remoteSigner(keys))
      expect(signed.headers.get(Headers.signatureInput)).toContain(';alg="' + alg + '";')
      expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
    })

    test('work as class instances that use this', async () => {
      const keys = await keyPair()
      class KmsSigner {
        readonly publicKey = keys.publicKey
        readonly #privateKey = keys.privateKey
        async sign({ payload }: { readonly payload: Uint8Array }) {
          return new Uint8Array(
            await crypto.subtle.sign('Ed25519', this.#privateKey, payload.slice()),
          )
        }
      }
      expect(await verify(await sign(new KmsSigner()), keys.publicKey)).toMatchObject({
        status: 'verified',
      })
    })

    test.each([
      [
        'a view into a larger buffer',
        (signature: Uint8Array) => {
          const padded = new Uint8Array(signature.length + 16).fill(0xff)
          padded.set(signature, 8)
          return padded.subarray(8, 8 + signature.length)
        },
      ],
      ['a Node.js Buffer', (signature: Uint8Array) => Buffer.from(signature)],
    ])('may return %s', async (_, wrap) => {
      const keys = await keyPair()
      const inner = remoteSigner(keys)
      const signed = await sign({
        publicKey: keys.publicKey,
        sign: async (parameters: { payload: Uint8Array }) => wrap(await inner.sign(parameters)),
      })
      expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
    })

    test('may return a Uint8Array from another realm', async () => {
      const keys = await keyPair()
      const inner = remoteSigner(keys)
      const signed = await sign({
        publicKey: keys.publicKey,
        async sign(parameters: { payload: Uint8Array }) {
          const signature = await inner.sign(parameters)
          // A Uint8Array built in a separate vm context fails instanceof here.
          const foreign = vm.runInNewContext('new Uint8Array(bytes)', { bytes: [...signature] })
          expect(foreign instanceof Uint8Array).toBe(false)
          return foreign
        },
      })
      expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
    })

    test('reject a typed array that is not a Uint8Array from another realm', async () => {
      const keys = await keyPair()
      await expect(
        sign({
          publicKey: keys.publicKey,
          sign: async () => vm.runInNewContext('new Uint16Array(32)'),
        }),
      ).rejects.toThrow('A Signer must resolve with the raw signature as a Uint8Array.')
    })

    test('cannot change the signature after it is checked', async () => {
      const keys = await keyPair()
      let returned: Uint8Array | undefined
      const inner = remoteSigner(keys)
      const signed = await sign({
        publicKey: keys.publicKey,
        async sign(parameters: { payload: Uint8Array }) {
          returned = await inner.sign(parameters)
          setTimeout(() => returned!.fill(0))
          return returned
        },
      })
      await new Promise((resolve) => setTimeout(resolve))
      expect(returned!.every((byte) => byte === 0)).toBe(true)
      expect(signed.headers.get(Headers.signature)).toBe(
        (await sign(keys)).headers.get(Headers.signature),
      )
    })

    test('cannot change the signature base by mutating the payload', async () => {
      const keys = await keyPair()
      const inner = remoteSigner(keys)
      const signed = await sign({
        publicKey: keys.publicKey,
        async sign(parameters: { payload: Uint8Array }) {
          const signature = await inner.sign(parameters)
          parameters.payload.fill(0)
          return signature
        },
      })
      expect(await verify(signed, keys.publicKey)).toMatchObject({ status: 'verified' })
    })

    test('keep existing signatures on the request', async () => {
      const [first, second] = await Promise.all([keyPair(), keyPair()])
      const once = await sign(first, { label: 'first' })
      const twice = await HttpMessageSignature.sign(once, {
        ...signOptions,
        key: remoteSigner(second),
        label: 'second',
      })
      const signature = twice.headers.get(Headers.signature)!
      expect(signature).toMatch(/^first=:[^:]+:, second=:[^:]+:$/)
      expect(signature.startsWith(once.headers.get(Headers.signature)!)).toBe(true)
    })
  })

  describe('the self-check rejects', () => {
    const mismatch = 'The Signer returned a signature that does not verify with its publicKey.'

    test('a signature from a different private key', async () => {
      const [signing, claimed] = await Promise.all([keyPair(), keyPair()])
      await expect(
        sign({ publicKey: claimed.publicKey, sign: remoteSigner(signing).sign }),
      ).rejects.toThrow(mismatch)
    })

    test('an RSA-PSS signature with the wrong salt length', async () => {
      const keys = await rsaKeyPair()
      await expect(sign(remoteSigner(keys, { saltLength: 32 }))).rejects.toThrow(mismatch)
    })

    test('a signature over a digest instead of the payload', async () => {
      const keys = await keyPair()
      await expect(
        sign({
          publicKey: keys.publicKey,
          async sign({ payload }: { payload: Uint8Array }) {
            const digest = await crypto.subtle.digest('SHA-256', payload.slice())
            return new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, digest))
          },
        }),
      ).rejects.toThrow(mismatch)
    })

    test('a DER-style signature with extra bytes', async () => {
      const keys = await keyPair()
      const inner = remoteSigner(keys)
      await expect(
        sign({
          publicKey: keys.publicKey,
          sign: async (parameters: { payload: Uint8Array }) =>
            Uint8Array.from([0x30, 0x44, ...(await inner.sign(parameters))]),
        }),
      ).rejects.toThrow(mismatch)
    })

    test.each([0, 63, 65])('a %i-byte Ed25519 signature', async (length) => {
      const keys = await keyPair()
      await expect(
        sign({ publicKey: keys.publicKey, sign: async () => new Uint8Array(length) }),
      ).rejects.toThrow(mismatch)
    })

    test('an empty RSA-PSS signature', async () => {
      const keys = await rsaKeyPair()
      await expect(
        sign({ publicKey: keys.publicKey, sign: async () => new Uint8Array() }),
      ).rejects.toThrow(mismatch)
    })

    test.each([
      ['a base64 string', 'c2lnbmF0dXJl'],
      ['an ArrayBuffer', new ArrayBuffer(64)],
      ['a number array', Array.from({ length: 64 }, () => 1)],
      ['undefined', undefined],
    ])('%s instead of bytes', async (_, value) => {
      const keys = await keyPair()
      await expect(sign({ publicKey: keys.publicKey, sign: async () => value })).rejects.toThrow(
        'A Signer must resolve with the raw signature as a Uint8Array.',
      )
    })
  })

  describe('configuration errors throw before signing', () => {
    test('a private key alone, as the old API took', async () => {
      const keys = await keyPair()
      await expect(sign(keys.privateKey)).rejects.toThrow(
        'Signing keys are key pairs: pass { privateKey, publicKey } or a Signer, not a private key alone.',
      )
    })

    test.each([
      ['null', null],
      ['an empty object', {}],
      ['a Signer without publicKey', { sign: async () => new Uint8Array(64) }],
      ['a Signer whose sign is not a function', { publicKey: 'x', sign: 'x' }],
    ])('%s', async (_, key) => {
      await expect(sign(key)).rejects.toThrow(
        'A signing key must be a CryptoKeyPair or a Signer with publicKey and sign.',
      )
    })

    test('a Signer whose publicKey is a private key', async () => {
      const keys = await keyPair()
      let called = false
      await expect(
        sign({
          publicKey: keys.privateKey,
          async sign() {
            called = true
            return new Uint8Array(64)
          },
        }),
      ).rejects.toThrow('A signing key must be a CryptoKeyPair or a Signer')
      expect(called).toBe(false)
    })

    test('a Signer whose publicKey cannot verify', async () => {
      const keys = await keyPair()
      const publicKey = await crypto.subtle.importKey(
        'jwk',
        await crypto.subtle.exportKey('jwk', keys.publicKey),
        'Ed25519',
        true,
        [],
      )
      await expect(sign({ publicKey, sign: remoteSigner(keys).sign })).rejects.toThrow(
        'A Signer publicKey must have the verify usage.',
      )
    })

    test.each([
      ['ECDSA P-256', { name: 'ECDSA', namedCurve: 'P-256' }],
      [
        'RSA-PSS SHA-256',
        {
          hash: 'SHA-256',
          modulusLength: 2_048,
          name: 'RSA-PSS',
          publicExponent: new Uint8Array([1, 0, 1]),
        },
      ],
    ])('an unsupported %s key, without calling the signer', async (_, algorithm) => {
      const keys = (await crypto.subtle.generateKey(algorithm, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair
      let called = false
      await expect(
        sign({
          publicKey: keys.publicKey,
          async sign() {
            called = true
            return new Uint8Array(64)
          },
        }),
      ).rejects.toThrow('Signing keys must be Ed25519 or RSA-PSS SHA-512.')
      await expect(sign(keys)).rejects.toThrow('Signing keys must be Ed25519 or RSA-PSS SHA-512.')
      expect(called).toBe(false)
    })

    test('a key pair whose halves use different algorithms', async () => {
      const [ed25519, rsa] = await Promise.all([keyPair(), rsaKeyPair()])
      await expect(
        sign({ privateKey: rsa.privateKey, publicKey: ed25519.publicKey }),
      ).rejects.toThrow(
        'The privateKey and publicKey of a signing key pair use different algorithms.',
      )
    })
  })

  test.each([
    [
      'a label that already exists',
      { 'Signature-Input': 'test=();created=1', Signature: 'test=:AA==:' },
      'HTTP message signature label "test" already exists.',
    ],
    [
      'mismatched signature labels',
      { 'Signature-Input': 'other=();created=1' },
      'Signature-Input and Signature must contain the same labels.',
    ],
  ])('refuses %s without calling the remote signer', async (_, headers, message) => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource', { headers }), {
        ...signOptions,
        key: remoteSigner(keys, { calls }),
      }),
    ).rejects.toThrow(message)
    expect(calls).toHaveLength(0)
  })

  test('refuses an invalid label without calling the remote signer', async () => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        ...signOptions,
        key: remoteSigner(keys, { calls }),
        label: 'TAP',
      }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('refuses a consumed body without calling the remote signer', async () => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    const request = new Request('https://merchant.example/resource', { body: 'x', method: 'POST' })
    await request.text()
    await expect(
      HttpMessageSignature.sign(request, { ...signOptions, key: remoteSigner(keys, { calls }) }),
    ).rejects.toThrow('Cannot sign a request whose body has already been read.')
    expect(calls).toHaveLength(0)
  })

  test('a signer failure propagates unchanged', async () => {
    const keys = await keyPair()
    const failure = new Error('KMS unavailable.')
    await expect(
      sign({
        publicKey: keys.publicKey,
        sign: async () => {
          throw failure
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
