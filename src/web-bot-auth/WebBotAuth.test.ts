import * as Attestation from 'mppx/attestation'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair, rsaKeyPair } from '~test/Attestation.js'

import * as HttpMessageSignature from '../attestation/internal/HttpMessageSignature.js'

test('emits and verifies a signed Signature-Agent member', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signatureAgent = 'https://agent.example'
  const signed = await WebBotAuth.Client.signer({
    expiresIn: WebBotAuth.Constants.defaultSignatureLifetime + 1,
    key: keys.privateKey,
    keyId,
    signatureAgent: `${signatureAgent}/`,
  }).sign(new Request('https://merchant.example/resource'))

  expect(signed.headers.get(WebBotAuth.Constants.signatureAgentHeader)).toBe(
    `${WebBotAuth.Constants.label}="${signatureAgent}"`,
  )
  expect(signed.headers.get(Attestation.Headers.signatureInput)).toContain(
    `"signature-agent";key="${WebBotAuth.Constants.label}"`,
  )
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      maxAge: WebBotAuth.Constants.defaultSignatureLifetime,
      nonceStore: Attestation.NonceStore.memory(),
    }).verify(signed),
  ).toMatchObject({ status: 'invalid' })
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Attestation.NonceStore.memory(),
    }).verify(signed),
  ).toMatchObject({
    status: 'verified',
    value: { keyId, signatureAgent },
  })
})

test('signs and verifies RSA-PSS SHA-512', async () => {
  const keys = await rsaKeyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const algorithms: Attestation.SignatureAlgorithm[] = []
  const signed = await WebBotAuth.Client.signer({
    key: keys.privateKey,
    keyId,
    signatureAgent: 'https://agent.example',
  }).sign(new Request('https://merchant.example/resource'))
  const result = await WebBotAuth.Server.verifier({
    keyResolver({ algorithm, keyId: candidate }) {
      algorithms.push(algorithm)
      return candidate === keyId ? keys.publicKey : undefined
    },
    nonceStore: Attestation.NonceStore.memory(),
  }).verify(signed)

  expect(signed.headers.get(Attestation.Headers.signatureInput)).toContain(
    `alg="${Attestation.Algorithms.rsaPssSha512}"`,
  )
  expect(algorithms).toEqual([Attestation.Algorithms.rsaPssSha512])
  expect(result).toMatchObject({ status: 'verified' })
})

test('preserves directory lookup failures as unverified outcomes', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signed = await WebBotAuth.Client.signer({
    key: keys.privateKey,
    keyId,
    signatureAgent: 'https://agent.example',
  }).sign(new Request('https://merchant.example/resource'))

  expect(
    await WebBotAuth.Server.verifier({
      keyResolver: () => undefined,
      nonceStore: Attestation.NonceStore.memory(),
    }).verify(signed),
  ).toEqual({
    reason: 'No public key is available for the signature key ID.',
    status: 'unverified',
  })
  expect(
    await WebBotAuth.Server.verifier({
      keyResolver() {
        throw new Error('directory unavailable')
      },
      nonceStore: Attestation.NonceStore.memory(),
    }).verify(signed),
  ).toEqual({
    reason: 'The public key could not be resolved.',
    status: 'unverified',
  })
})

test('rejects mismatched keys, non-directory discovery, and header tampering', async () => {
  const advertisedKeys = await keyPair()
  const signingKeys = await keyPair()
  const advertisedKeyId = await jwkThumbprint(advertisedKeys.publicKey)
  const signatureAgent = 'https://agent.example'
  const signed = await WebBotAuth.Client.signer({
    key: signingKeys.privateKey,
    keyId: advertisedKeyId,
    signatureAgent,
  }).sign(new Request('https://merchant.example/resource'))
  const verifier = WebBotAuth.Server.verifier({
    keyResolver: () => signingKeys.publicKey,
    nonceStore: Attestation.NonceStore.memory(),
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
      nonceStore: Attestation.NonceStore.memory(),
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
      nonceStore: Attestation.NonceStore.memory(),
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

  expect(() => WebBotAuth.Client.signer({ ...config, keyId: 'not-a-thumbprint' })).toThrow(
    'Web Bot Auth keyId must be an RFC 7638 SHA-256 JWK thumbprint.',
  )
  expect(() => WebBotAuth.Client.signer({ ...config, signatureAgent: 'https://' })).toThrow(
    'Signature-Agent must identify a valid HTTPS origin.',
  )
  expect(() =>
    WebBotAuth.Client.signer({ ...config, signatureAgent: 'https://agent.example/keys' }),
  ).toThrow('Signature-Agent must identify a valid HTTPS origin.')
  expect(() => WebBotAuth.Client.signer({ ...config, expiresIn: 0 })).toThrow(
    'Web Bot Auth expiresIn must be a positive integer.',
  )
  expect(() =>
    WebBotAuth.Server.verifier({
      keyResolver: () => keys.publicKey,
      maxAge: 0,
      nonceStore: Attestation.NonceStore.memory(),
    }),
  ).toThrow('Web Bot Auth maxAge must be a positive integer.')
})
