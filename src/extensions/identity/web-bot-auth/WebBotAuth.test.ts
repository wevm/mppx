import * as Signatures from 'mppx/extensions/identity'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import * as Identity from 'mppx/identity'
import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair, rsaKeyPair } from '~test/Identity.js'

import * as HttpMessageSignature from '../internal/HttpMessageSignature.js'

test('emits and verifies a signed Signature-Agent member', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signatureAgent = 'https://agent.example'
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    expiresIn: WebBotAuth.Constants.defaultSignatureLifetime + 1,
    key: keys.privateKey,
    keyId,
    signatureAgent: `${signatureAgent}/`,
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(signed.headers.get(WebBotAuth.Constants.signatureAgentHeader)).toBe(
    `${WebBotAuth.Constants.label}="${signatureAgent}"`,
  )
  expect(signed.headers.get(Signatures.Headers.signatureInput)).toContain(
    `"signature-agent";key="${WebBotAuth.Constants.label}"`,
  )
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      maxAge: WebBotAuth.Constants.defaultSignatureLifetime,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({ status: 'invalid' })
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({
    status: 'valid',
    value: { keyId, signatureAgent },
  })
})

test('signs and verifies RSA-PSS SHA-512', async () => {
  const keys = await rsaKeyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const algorithms: Signatures.SignatureAlgorithm[] = []
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    key: keys.privateKey,
    keyId,
    signatureAgent: 'https://agent.example',
  }).prove(new Request('https://merchant.example/resource'), attempt())
  const result = await WebBotAuth.Server.verifier({
    keyResolver({ algorithm, keyId: candidate }) {
      algorithms.push(algorithm)
      return candidate === keyId ? keys.publicKey : undefined
    },
    nonceStore: Identity.Store.memory(),
  }).verify(signed)

  expect(signed.headers.get(Signatures.Headers.signatureInput)).toContain(
    `alg="${Signatures.Algorithms.rsaPssSha512}"`,
  )
  expect(algorithms).toEqual([Signatures.Algorithms.rsaPssSha512])
  expect(result).toMatchObject({ status: 'valid' })
})

test('signs with an external Ed25519 key and preserves a sliced signature', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  let calls = 0
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    key: {
      algorithm: Signatures.Algorithms.ed25519,
      async sign(bytes) {
        calls++
        expect(new TextDecoder().decode(bytes)).toContain('"@authority": merchant.example')
        const signature = new Uint8Array(
          await crypto.subtle.sign('Ed25519', keys.privateKey, Uint8Array.from(bytes).buffer),
        )
        const padded = new Uint8Array(signature.length + 16).fill(0xff)
        padded.set(signature, 8)
        return padded.subarray(8, 8 + signature.length)
      },
    },
    keyId,
    signatureAgent: 'https://agent.example',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(calls).toBe(1)
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({ status: 'valid', value: { keyId } })
})

test('propagates external signing failures without returning a proved request', async () => {
  await expect(
    WebBotAuth.Client.prover({
      scope: '*',
      key: {
        algorithm: Signatures.Algorithms.ed25519,
        async sign() {
          throw new Error('Remote signer unavailable.')
        },
      },
      keyId: 'A'.repeat(43),
      signatureAgent: 'https://agent.example',
    }).prove(new Request('https://merchant.example/resource'), attempt()),
  ).rejects.toThrow('Remote signer unavailable.')
})

test('signs with an external RSA-PSS SHA-512 key', async () => {
  const keys = await rsaKeyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    key: {
      algorithm: Signatures.Algorithms.rsaPssSha512,
      async sign(bytes) {
        return new Uint8Array(
          await crypto.subtle.sign(
            { name: 'RSA-PSS', saltLength: 64 },
            keys.privateKey,
            bytes.slice(),
          ),
        )
      },
    },
    keyId,
    signatureAgent: 'https://agent.example',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(signed.headers.get('Signature-Input')).toContain('alg="rsa-pss-sha512"')
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({ status: 'valid', value: { keyId } })
})

test('reports directory lookup failures as forbidden (403) identities', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    key: keys.privateKey,
    keyId,
    signatureAgent: 'https://agent.example',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => undefined,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toEqual({
    reason: 'No public key is available for the signature key ID.',
    status: 'forbidden',
  })
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver() {
        throw new Error('directory unavailable')
      },
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toEqual({
    reason: 'The public key could not be resolved.',
    status: 'forbidden',
  })
})

test('rejects mismatched keys, non-directory discovery, and header tampering', async () => {
  const advertisedKeys = await keyPair()
  const signingKeys = await keyPair()
  const advertisedKeyId = await jwkThumbprint(advertisedKeys.publicKey)
  const signatureAgent = 'https://agent.example'
  const signed = await WebBotAuth.Client.prover({
    scope: '*',
    key: signingKeys.privateKey,
    keyId: advertisedKeyId,
    signatureAgent,
  }).prove(new Request('https://merchant.example/resource'), attempt())
  const verifier = WebBotAuth.Server.verifier({
    keyResolver: () => signingKeys.publicKey,
    nonceStore: Identity.Store.memory(),
  })

  expect(await verifier.verify(signed)).toMatchObject({ status: 'invalid' })

  const alteredHeaders = new Headers(signed.headers)
  alteredHeaders.set(
    WebBotAuth.Constants.signatureAgentHeader,
    `${WebBotAuth.Constants.label}="https://attacker.example"`,
  )
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => signingKeys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(new Request(signed, { headers: alteredHeaders })),
  ).toMatchObject({ status: 'invalid' })

  const discoveryHeaders = new Headers({
    [WebBotAuth.Constants.signatureAgentHeader]:
      'webbot="https://agent.example/keys";type=jwks_uri',
  })
  const unsupportedDiscovery = await HttpMessageSignature.sign(
    new Request('https://merchant.example/resource', { headers: discoveryHeaders }),
    {
      components: [
        HttpMessageSignature.Constants.components.authority,
        {
          id: HttpMessageSignature.Constants.components.signatureAgent,
          parameters: new Map([['key', WebBotAuth.Constants.label]]),
        },
      ],
      key: advertisedKeys.privateKey,
      keyId: advertisedKeyId,
      label: WebBotAuth.Constants.label,
      tag: WebBotAuth.Constants.tag,
    },
  )
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => advertisedKeys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(unsupportedDiscovery),
  ).toMatchObject({
    reason: 'The Signature-Agent discovery type is not supported by this directory profile.',
    status: 'invalid',
  })
})

test('validates signer and verifier configuration', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const config = { key: keys.privateKey, keyId, signatureAgent: 'https://agent.example' }

  expect(() =>
    WebBotAuth.Client.prover({
      scope: '*',
      ...config,
      keyId: 'not-a-thumbprint',
    }),
  ).toThrow('Web Bot Auth keyId must be an RFC 7638 SHA-256 JWK thumbprint.')
  expect(() =>
    WebBotAuth.Client.prover({
      scope: '*',
      ...config,
      signatureAgent: 'https://',
    }),
  ).toThrow('Signature-Agent must identify a valid HTTPS origin.')
  expect(() =>
    WebBotAuth.Client.prover({
      scope: '*',
      ...config,
      signatureAgent: 'https://agent.example/keys',
    }),
  ).toThrow('Signature-Agent must identify a valid HTTPS origin.')
  expect(() =>
    WebBotAuth.Client.prover({
      scope: '*',
      ...config,
      expiresIn: 0,
    }),
  ).toThrow('Web Bot Auth expiresIn must be a positive integer.')
  expect(() =>
    WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      maxAge: 0,
      nonceStore: Identity.Store.memory(),
    }),
  ).toThrow('Web Bot Auth maxAge must be a positive integer.')
})

function attempt() {
  return {
    created: Math.floor(Date.now() / 1_000),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64url'),
  }
}
