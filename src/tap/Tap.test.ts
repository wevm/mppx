import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import { serializeDictionary, serializeInnerList } from 'structured-headers'
import type { BareItem, InnerList } from 'structured-headers'
import { expect, test } from 'vp/test'
import { keyPair } from '~test/Attestation.js'

test('signs and verifies a request-bound TAP payment intent', async () => {
  const keys = await keyPair()
  const signer = Tap.Client.signer({
    intent: Tap.Constants.intents.payment,
    key: keys.privateKey,
    keyId: 'tap-agent',
  })
  const signed = await signer.sign(new Request('https://merchant.example/resource'))
  const createVerifier = () =>
    Tap.Server.verifier({
      keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
      nonceStore: Attestation.Store.memory(),
    })

  expect(await createVerifier().verify(signed)).toMatchObject({
    status: 'verified',
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
    Attestation.Headers.signatureInput,
    headers.get(Attestation.Headers.signatureInput)!.replace('alg="ed25519"', 'alg="invalid"'),
  )
  expect(await createVerifier().verify(new Request(signed, { headers }))).toMatchObject({
    status: 'invalid',
  })
  expect(() =>
    Tap.Client.signer({
      expiresIn: Tap.Constants.maximumSignatureLifetime + 1,
      intent: Tap.Constants.intents.payment,
      key: keys.privateKey,
      keyId: 'tap-agent',
    }),
  ).toThrow('TAP expiresIn must be an integer')
})

test('shares replay protection across verifier instances and TAP intents', async () => {
  const keys = await keyPair()
  const nonceStore = Attestation.Store.memory()
  const context = {
    created: Math.floor(Date.now() / 1_000),
    nonce: 'A'.repeat(86),
  } as const
  const browse = await Tap.Client.signer({
    intent: Tap.Constants.intents.browse,
    key: keys.privateKey,
    keyId: 'tap-agent',
  }).sign(new Request('https://merchant.example/browse'), context)
  const payment = await Tap.Client.signer({
    intent: Tap.Constants.intents.payment,
    key: keys.privateKey,
    keyId: 'tap-agent',
  }).sign(new Request('https://merchant.example/payment'), context)
  const createVerifier = () =>
    Tap.Server.verifier({ keyResolver: () => keys.publicKey, nonceStore })

  expect(await createVerifier().verify(browse)).toMatchObject({ status: 'verified' })
  expect(await createVerifier().verify(payment)).toEqual({
    reason: 'The signature nonce has already been used.',
    status: 'invalid',
  })
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
    [Attestation.Headers.signatureInput]: serializeDictionary(
      new Map([[Tap.Constants.label, input]]),
    ),
    [Attestation.Headers.signature]: serializeDictionary(
      new Map([[Tap.Constants.label, [signature, new Map()]]]),
    ),
  })
  const verifier = Tap.Server.verifier({
    keyResolver: ({ keyId }) => (keyId === 'tap-agent' ? keys.publicKey : undefined),
    nonceStore: Attestation.Store.memory(),
  })

  expect(await verifier.verify(new Request(request, { headers }))).toMatchObject({
    status: 'verified',
  })
})
