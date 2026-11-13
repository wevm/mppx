import * as Signatures from 'mppx/extensions/identity'
import * as Tap from 'mppx/extensions/identity/tap'
import * as Identity from 'mppx/identity'
import { serializeDictionary, serializeInnerList } from 'structured-headers'
import type { BareItem, InnerList } from 'structured-headers'
import { expect, test } from 'vp/test'
import { keyPair, remoteSigner, rsaKeyPair } from '~test/Identity.js'

test('signs and verifies a request-bound TAP payment intent', async () => {
  const keys = await keyPair()
  const signer = Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: keys,
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
      key: keys,
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
    key: keys,
    keyId: 'tap-agent',
  }).prove(new Request('https://merchant.example/browse'), context)
  const payment = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: keys,
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

test.each([
  ['Ed25519', keyPair],
  ['RSA-PSS SHA-512', rsaKeyPair],
])('signs a TAP payment intent with a remote %s signer', async (_, generate) => {
  const keys = await generate()
  const calls: Uint8Array[] = []
  const signed = await Tap.Client.prover({
    scope: '*',
    intent: Tap.Constants.intents.payment,
    key: remoteSigner(keys, { calls }),
    keyId: 'remote-tap-agent',
  }).prove(new Request('https://merchant.example/resource'), attempt())

  expect(calls).toHaveLength(1)
  expect(new TextDecoder().decode(calls[0])).toContain('"@path": /resource')
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

test('rejects a private key alone when the prover is created', async () => {
  const keys = await keyPair()
  expect(() =>
    Tap.Client.prover({
      scope: '*',
      intent: Tap.Constants.intents.payment,
      key: keys.privateKey as never,
      keyId: 'agent',
    }),
  ).toThrow('Signing keys are key pairs')
})

test('propagates TAP remote signing failures', async () => {
  const keys = await keyPair()
  await expect(
    Tap.Client.prover({
      scope: '*',
      intent: Tap.Constants.intents.payment,
      key: {
        publicKey: keys.publicKey,
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
