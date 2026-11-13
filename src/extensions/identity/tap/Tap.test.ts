import * as Signatures from 'mppx/extensions/identity'
import * as Tap from 'mppx/extensions/identity/tap'
import * as Identity from 'mppx/identity'
import { serializeDictionary, serializeInnerList } from 'structured-headers'
import type { BareItem, InnerList } from 'structured-headers'
import { expect, test } from 'vp/test'
import { keyPair, rsaKeyPair } from '~test/Identity.js'

test('signs and verifies a request-bound TAP payment intent', async () => {
  const keys = await keyPair()
  const signer = Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: keys.privateKey,
    keyId: 'tap-agent',
  })
  const signed = await signer.prove(new Request('https://merchant.example/resource'), attempt())
  const createVerifier = () =>
    Tap.Server.verifier({
      keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
      nonceStore: Identity.Store.memory(),
    })

  expect(await createVerifier().verify(signed)).toMatchObject({
    status: 'valid',
    value: {
      intent: Tap.Constants.intents.payment,
      keyId: 'tap-agent',
    },
  })
  expect(
    await createVerifier().verify(
      new Request('https://merchant.example/different-resource', { headers: signed.headers }),
    ),
  ).toMatchObject({ status: 'invalid' })

  const headers = new Headers(signed.headers)
  headers.set(
    Signatures.Headers.signatureInput,
    headers.get(Signatures.Headers.signatureInput)!.replace('alg="ed25519"', 'alg="invalid"'),
  )
  expect(await createVerifier().verify(new Request(signed, { headers }))).toMatchObject({
    status: 'invalid',
  })
  expect(() =>
    Tap.Client.prover({
      scope: '*',
      expiresIn: Tap.Constants.maximumSignatureLifetime + 1,
      intent: Tap.Constants.intents.payment,
      key: keys.privateKey,
      keyId: 'tap-agent',
    }),
  ).toThrow('TAP expiresIn must be an integer')
})

test('shares replay protection across verifier instances and TAP intents', async () => {
  const keys = await keyPair()
  const nonceStore = Identity.Store.memory()
  const context = {
    created: Math.floor(Date.now() / 1_000),
    nonce: 'A'.repeat(86),
  } as const
  const browse = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.browse,
    key: keys.privateKey,
    keyId: 'tap-agent',
  }).prove(new Request('https://merchant.example/browse'), context)
  const payment = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: keys.privateKey,
    keyId: 'tap-agent',
  }).prove(new Request('https://merchant.example/payment'), context)
  const createVerifier = () =>
    Tap.Server.verifier({ keyResolver: () => keys.publicKey, nonceStore })

  expect(await createVerifier().verify(browse)).toMatchObject({ status: 'valid' })
  expect(await createVerifier().verify(payment)).toEqual({
    reason: 'The signature nonce has already been used.',
    status: 'invalid',
  })
})

test('signs a TAP payment intent with an external Ed25519 key', async () => {
  const keys = await keyPair()
  const signed = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: {
      algorithm: Signatures.Algorithms.ed25519,
      async sign(bytes) {
        expect(new TextDecoder().decode(bytes)).toContain('"@path": /resource')
        return new Uint8Array(
          await crypto.subtle.sign('Ed25519', keys.privateKey, Uint8Array.from(bytes).buffer),
        )
      },
    },
    keyId: 'remote-tap-agent',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(
    await Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({
    status: 'valid',
    value: { intent: Tap.Constants.intents.payment, keyId: 'remote-tap-agent' },
  })
})

test('signs a TAP intent with an external RSA-PSS SHA-512 key', async () => {
  const keys = await rsaKeyPair()
  const signed = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
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
    keyId: 'remote-rsa-agent',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(
    await Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Identity.Store.memory(),
    }).verify(signed),
  ).toMatchObject({ status: 'valid', value: { keyId: 'remote-rsa-agent' } })
})

test('propagates TAP external signing failures', async () => {
  await expect(
    Tap.Client.prover({
      scope: '*',
      intent: Tap.Constants.intents.payment,
      key: {
        algorithm: Signatures.Algorithms.ed25519,
        async sign() {
          throw new Error('HSM unavailable.')
        },
      },
      keyId: 'agent',
    }).prove(new Request('https://merchant.example/resource'), attempt()),
  ).rejects.toThrow('HSM unavailable.')
})

test('verifies externally ordered signature parameters and extensions', async () => {
  const keys = await keyPair()
  const request = new Request('https://merchant.example/resource')
  const created = Math.floor(Date.now() / 1_000)
  const input: InnerList = [
    [
      ['@authority', new Map()],
      ['@path', new Map()],
    ],
    new Map<string, BareItem>([
      ['tag', Tap.Constants.tags.payment],
      ['nonce', 'external-signer-nonce'],
      ['alg', 'ed25519'],
      ['keyid', 'tap-agent'],
      ['expires', created + 60],
      ['created', created],
      ['extension', 'preserve-me'],
    ]),
  ]
  const signatureBase = [
    '"@authority": merchant.example',
    '"@path": /resource',
    `"@signature-params": ${serializeInnerList(input)}`,
  ].join('\n')
  const signature = await crypto.subtle.sign(
    'Ed25519',
    keys.privateKey,
    new TextEncoder().encode(signatureBase),
  )
  const headers = new Headers({
    [Signatures.Headers.signatureInput]: serializeDictionary(
      new Map([[Tap.Constants.label, input]]),
    ),
    [Signatures.Headers.signature]: serializeDictionary(
      new Map([[Tap.Constants.label, [signature, new Map()]]]),
    ),
  })
  const verifier = Tap.Server.verifier({
    keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
    nonceStore: Identity.Store.memory(),
  })

  expect(await verifier.verify(new Request(request, { headers }))).toMatchObject({
    status: 'valid',
  })
})

function attempt() {
  return {
    created: Math.floor(Date.now() / 1_000),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64url'),
  }
}
