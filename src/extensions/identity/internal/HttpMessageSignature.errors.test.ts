import { describe, expect, test } from 'vp/test'
import { keyPair } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import * as HttpMessageSignature from './HttpMessageSignature.js'

const url = 'https://merchant.example/checkout'
const keys = await keyPair()
const tag = 'agent-browser-auth'

function now() {
  return Math.floor(Date.now() / 1_000)
}

function options(overrides: Partial<Parameters<typeof HttpMessageSignature.verify>[1]> = {}) {
  return {
    keyResolver: () => keys.publicKey,
    maxAge: 480,
    nonceNamespace: 'test',
    nonceStore: Store.memory(),
    requiredComponents: ['@authority', '@path'],
    tag,
    ...overrides,
  }
}

async function sign(
  request: Request = new Request(url),
  overrides: Partial<Parameters<typeof HttpMessageSignature.sign>[1]> = {},
) {
  return HttpMessageSignature.sign(request, {
    components: ['@authority', '@path'],
    context: { created: now(), nonce: crypto.randomUUID() },
    key: keys,
    keyId: 'agent',
    label: 'tap',
    tag,
    ...overrides,
  })
}

function raw(input: string, signature = 'tap=:' + Buffer.alloc(64).toString('base64') + ':') {
  return new Request(url, { headers: { 'Signature-Input': input, Signature: signature } })
}

const params = () =>
  ';created=' +
  now() +
  ';expires=' +
  (now() + 60) +
  ';keyid="agent";alg="ed25519";nonce="n";tag="' +
  tag +
  '"'

describe('verify answers', () => {
  test.each([
    ['no signature headers', new Request(url), { status: 'absent' }],
    [
      'Signature without Signature-Input',
      new Request(url, { headers: { Signature: 'tap=:AA==:' } }),
      { reason: 'Signature-Input and Signature must both be provided.', status: 'invalid' },
    ],
    [
      'Signature-Input without Signature',
      new Request(url, { headers: { 'Signature-Input': 'tap=("@path")' } }),
      { reason: 'Signature-Input and Signature must both be provided.', status: 'invalid' },
    ],
    [
      'an unparsable dictionary',
      raw('tap=(("'),
      { reason: 'The HTTP message signature is malformed.', status: 'invalid' },
    ],
    [
      'labels that differ',
      raw('tap=("@authority" "@path")' + params(), 'other=:AA==:'),
      {
        reason: 'Signature-Input and Signature do not contain the same labels.',
        status: 'invalid',
      },
    ],
    [
      'a signature that is not a byte sequence',
      raw('tap=("@authority" "@path")' + params(), 'tap="AA=="'),
      { reason: 'No matching HTTP message signature was provided.', status: 'invalid' },
    ],
    [
      'a signature that is an inner list',
      raw('tap=("@authority" "@path")' + params(), 'tap=(:AA==:)'),
      { reason: 'No matching HTTP message signature was provided.', status: 'invalid' },
    ],
    [
      'a missing required component',
      raw('tap=("@authority")' + params()),
      {
        reason: 'The signature does not cover the required request components.',
        status: 'invalid',
      },
    ],
    ['an item instead of an inner list', raw('tap=1;tag="' + tag + '"'), { status: 'absent' }],
    [
      'only an unrelated tag',
      raw(
        'tap=("@authority" "@path");created=1;expires=2;keyid="a";alg="ed25519";nonce="n";tag="other"',
      ),
      { status: 'absent' },
    ],
  ])('%s', async (_, request, expected) => {
    expect(await HttpMessageSignature.verify(request, options())).toEqual(expected)
  })

  test.each([
    ['no components', 'tap=()' + params()],
    ['a component that is not a string', 'tap=(@path)' + params()],
    [
      'a created time that is not an integer',
      'tap=("@authority" "@path");created=1.5;expires=2;keyid="a";alg="ed25519";nonce="n";tag="' +
        tag +
        '"',
    ],
    [
      'a created time that is a string',
      'tap=("@authority" "@path");created="1";expires=2;keyid="a";alg="ed25519";nonce="n";tag="' +
        tag +
        '"',
    ],
    [
      'an expiry that is missing',
      'tap=("@authority" "@path");created=1;keyid="a";alg="ed25519";nonce="n";tag="' + tag + '"',
    ],
    [
      'a key ID that is not a string',
      'tap=("@authority" "@path");created=1;expires=2;keyid=1;alg="ed25519";nonce="n";tag="' +
        tag +
        '"',
    ],
    [
      'a nonce that is missing',
      'tap=("@authority" "@path");created=1;expires=2;keyid="a";alg="ed25519";tag="' + tag + '"',
    ],
    [
      'an unregistered algorithm',
      'tap=("@authority" "@path");created=1;expires=2;keyid="a";alg="hmac-sha256";nonce="n";tag="' +
        tag +
        '"',
    ],
    [
      'an inherited property name as the algorithm',
      'tap=("@authority" "@path");created=1;expires=2;keyid="a";alg="toString";nonce="n";tag="' +
        tag +
        '"',
    ],
  ])('rejects %s as malformed', async (_, input) => {
    expect(await HttpMessageSignature.verify(raw(input), options())).toEqual({
      reason: 'The HTTP message signature is malformed.',
      status: 'invalid',
    })
  })

  test('rejects a signature whose expiry is now', async () => {
    const signed = await sign(new Request(url), {
      context: { created: now() - 60, nonce: 'x' },
      expiresIn: 60,
    })
    expect(await HttpMessageSignature.verify(signed, options())).toMatchObject({
      status: 'invalid',
    })
  })

  test('rejects a key of another type', async () => {
    const ecdsa = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    expect(
      await HttpMessageSignature.verify(
        await sign(),
        options({ keyResolver: () => ecdsa.publicKey }),
      ),
    ).toEqual({
      reason: 'The public key does not support the signature algorithm.',
      status: 'invalid',
    })
  })

  test('rejects an RSA-PSS key with another hash', async () => {
    const rsa = (await crypto.subtle.generateKey(
      {
        hash: 'SHA-512',
        modulusLength: 2_048,
        name: 'RSA-PSS',
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const sha256 = await crypto.subtle.importKey(
      'spki',
      await crypto.subtle.exportKey('spki', rsa.publicKey),
      { hash: 'SHA-256', name: 'RSA-PSS' },
      true,
      ['verify'],
    )
    const signed = await sign(new Request(url), { key: rsa })
    expect(
      await HttpMessageSignature.verify(signed, options({ keyResolver: () => sha256 })),
    ).toEqual({
      reason: 'The public key does not support the signature algorithm.',
      status: 'invalid',
    })
  })

  test('answers a key that cannot verify as an invalid signature', async () => {
    const exported = await crypto.subtle.exportKey('spki', keys.publicKey)
    const unusable = await crypto.subtle.importKey('spki', exported, 'Ed25519', true, [])
    expect(
      await HttpMessageSignature.verify(await sign(), options({ keyResolver: () => unusable })),
    ).toEqual({
      reason: 'The HTTP message signature is invalid.',
      status: 'invalid',
    })
  })

  test('returns the reason validateKey gives', async () => {
    expect(
      await HttpMessageSignature.verify(await sign(), options({ validateKey: () => 'nope' })),
    ).toEqual({
      reason: 'nope',
      status: 'invalid',
    })
  })

  test('answers an unavailable nonce store as unverified', async () => {
    const store = Store.memory()
    const failing = {
      ...store,
      tryClaim: () => Promise.reject(new Error('down')),
      update: () => Promise.reject(new Error('down')),
    } as unknown as Store.AtomicStore
    expect(
      await HttpMessageSignature.verify(await sign(), options({ nonceStore: failing })),
    ).toEqual({
      reason: 'Replay protection is unavailable.',
      status: 'unverified',
    })
  })

  test('claims nonces per key by default', async () => {
    const other = await keyPair()
    const nonceStore = Store.memory()
    const context = { created: now(), nonce: 'shared' }
    const first = await sign(new Request(url), { context })
    const second = await sign(new Request(url), { context, key: other, keyId: 'other' })
    expect((await HttpMessageSignature.verify(first, options({ nonceStore }))).status).toBe(
      'verified',
    )
    expect(
      (
        await HttpMessageSignature.verify(
          second,
          options({ keyResolver: () => other.publicKey, nonceStore }),
        )
      ).status,
    ).toBe('verified')
  })

  test('accepts several matching signatures unless unique', async () => {
    const both = await sign(await sign(), { label: 'tap2' })
    expect((await HttpMessageSignature.verify(both, options())).status).toBe('verified')
    expect(await HttpMessageSignature.verify(both, options({ unique: true }))).toMatchObject({
      status: 'invalid',
    })
  })

  test('verifies a covered digest of an empty GET body', async () => {
    const signed = await sign(await HttpMessageSignature.withContentDigest(new Request(url)), {
      components: ['@authority', '@path', 'content-digest'],
    })
    expect((await HttpMessageSignature.verify(signed, options())).status).toBe('verified')
  })

  test('answers a locked body as unavailable', async () => {
    const signed = await sign(
      await HttpMessageSignature.withContentDigest(new Request(url, { body: 'x', method: 'POST' })),
      {
        components: ['@authority', '@path', 'content-digest'],
      },
    )
    signed.body!.getReader()
    expect(await HttpMessageSignature.verify(signed, options())).toEqual({
      reason: 'The request body is unavailable to check its Content-Digest.',
      status: 'invalid',
    })
  })
})

describe('sign refuses', () => {
  test.each([
    [
      { id: '@authority', parameters: new Map([['req', true]]) },
      'Unsupported parameters for "@authority".',
    ],
    [{ id: '@path', parameters: new Map([['req', true]]) }, 'Unsupported parameters for "@path".'],
    ['x-missing', 'Missing signed HTTP header "x-missing".'],
    [
      { id: 'x-dict', parameters: new Map([['key', 1]]) },
      'Unsupported parameters for signed HTTP header "x-dict".',
    ],
    [
      {
        id: 'x-dict',
        parameters: new Map<string, string | boolean>([
          ['key', 'a'],
          ['bs', true],
        ]),
      },
      'Unsupported parameters for signed HTTP header "x-dict".',
    ],
    [
      { id: 'x-absent', parameters: new Map([['key', 'a']]) },
      'Missing signed HTTP header "x-absent".',
    ],
    [
      { id: 'x-bad', parameters: new Map([['key', 'a']]) },
      'Signed HTTP header "x-bad" is not a structured dictionary.',
    ],
    [
      { id: 'x-dict', parameters: new Map([['key', 'b']]) },
      'Signed HTTP header "x-dict" has no member "b".',
    ],
    [
      { id: 'x-list', parameters: new Map([['key', 'a']]) },
      'Signed HTTP header "x-list" has no member "a".',
    ],
  ])('%j', async (component, message) => {
    const request = new Request(url, {
      headers: { 'x-bad': '(((', 'x-dict': 'a=1', 'x-list': 'a=(1 2)' },
    })
    await expect(sign(request, { components: ['@authority', '@path', component] })).rejects.toThrow(
      message,
    )
  })

  test('an existing Signature-Input that is not a dictionary', async () => {
    await expect(sign(new Request(url, { headers: { 'Signature-Input': '(((' } }))).rejects.toThrow(
      'HTTP header "Signature-Input" is not a structured dictionary.',
    )
  })

  test('to digest a body that was already read', async () => {
    const request = new Request(url, { body: 'x', method: 'POST' })
    await request.text()
    await expect(HttpMessageSignature.withContentDigest(request)).rejects.toThrow(
      'Cannot digest a request whose body has already been read or is locked.',
    )
  })
})
