import { afterEach, describe, expect, test, vi } from 'vp/test'
import { keyPair } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import * as HttpMessageSignature from '../internal/HttpMessageSignature.js'
import * as Tap from './index.js'

const url = 'https://merchant.example/checkout'

afterEach(() => {
  vi.useRealTimers()
})

async function setup(
  options: { components?: readonly string[]; intent?: 'browse' | 'payment' } = {},
) {
  const keys = await keyPair()
  const prover = Tap.Client.prover({
    components: options.components,
    intent: options.intent ?? 'payment',
    key: keys,
    keyId: 'agent',
    scope: '*',
  })
  const verifier = (config: Partial<Tap.Server.verifier.Config> = {}) =>
    Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Store.memory(),
      ...config,
    })
  return { keys, prover, verifier }
}

function context(created = Math.floor(Date.now() / 1_000)) {
  return { created, nonce: crypto.randomUUID() }
}

describe('clockSkew', () => {
  test('rejects a created time in the future by default', async () => {
    const { prover, verifier } = await setup()
    const signed = await prover.prove(new Request(url), context(Math.floor(Date.now() / 1_000) + 3))
    expect(await verifier().verify(signed)).toMatchInlineSnapshot(`
      {
        "reason": "The signature is expired or has an invalid lifetime.",
        "status": "invalid",
      }
    `)
  })

  test('accepts a created time within the allowed skew', async () => {
    const { prover, verifier } = await setup()
    const signed = await prover.prove(new Request(url), context(Math.floor(Date.now() / 1_000) + 3))
    expect(await verifier({ clockSkew: 5 }).verify(signed)).toMatchObject({ status: 'valid' })
  })

  test('accepts an expired signature only within the allowed skew', async () => {
    const { keys, verifier } = await setup()
    const created = Math.floor(Date.now() / 1_000) - 63
    const prover = Tap.Client.prover({
      expiresIn: 60,
      intent: 'payment',
      key: keys,
      keyId: 'agent',
      scope: '*',
    })
    const signed = await prover.prove(new Request(url), context(created))
    expect((await verifier({ clockSkew: 5 }).verify(signed.clone())).status).toBe('valid')
    expect((await verifier({ clockSkew: 2 }).verify(signed)).status).toBe('invalid')
  })

  test.each([-1, 1.5, 61])('refuses clockSkew %s', async (clockSkew) => {
    const { verifier } = await setup()
    expect(() => verifier({ clockSkew })).toThrow('TAP clockSkew must be an integer from 0 to 60.')
  })
})

describe('requiredComponents', () => {
  test('rejects a payment signature that covers only the TAP minimum', async () => {
    const { prover, verifier } = await setup()
    const signed = await prover.prove(new Request(url, { method: 'POST', body: '{}' }), context())
    expect(
      await verifier({ requiredComponents: { payment: ['@method', 'content-digest'] } }).verify(
        signed,
      ),
    ).toMatchInlineSnapshot(`
      {
        "reason": "The signature does not cover the components this verifier requires.",
        "status": "invalid",
      }
    `)
  })

  test('accepts a payment signature that covers the method and body', async () => {
    const { prover, verifier } = await setup({ components: ['@method', 'content-digest'] })
    const signed = await prover.prove(
      new Request(url, { method: 'POST', body: '{"a":1}' }),
      context(),
    )
    expect(signed.headers.get('Content-Digest')).toMatchInlineSnapshot(
      `"sha-256=:AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=:"`,
    )
    expect(
      await verifier({ requiredComponents: { payment: ['@method', 'content-digest'] } }).verify(
        signed,
      ),
    ).toMatchObject({ status: 'valid', value: { intent: 'payment' } })
  })

  test('applies payment requirements only to payment signatures', async () => {
    const { prover, verifier } = await setup({ intent: 'browse' })
    const signed = await prover.prove(new Request(url), context())
    expect(
      await verifier({ requiredComponents: { payment: ['@method'] } }).verify(signed),
    ).toMatchObject({ status: 'valid', value: { intent: 'browse' } })
  })

  test('refuses to cover a required component twice', async () => {
    const { keys } = await setup()
    const prover = Tap.Client.prover({
      components: ['@path'],
      intent: 'payment',
      key: keys,
      keyId: 'agent',
      scope: '*',
    })
    await expect(prover.prove(new Request(url), context())).rejects.toThrow(
      'Covered components must be unique and must not include "@signature-params".',
    )
  })
})

describe('content-digest', () => {
  async function signedPost(body: string, digest?: string) {
    const { keys, verifier } = await setup({ components: ['content-digest'] })
    const headers: Record<string, string> = digest ? { 'Content-Digest': digest } : {}
    const signed = await HttpMessageSignature.sign(
      new Request(url, { method: 'POST', body, headers }),
      {
        components: ['@authority', '@path', 'content-digest'],
        context: context(),
        expiresIn: 60,
        key: keys,
        keyId: 'agent',
        label: 'tap',
        tag: 'agent-payer-auth',
      },
    )
    return { signed, verifier }
  }

  test('rejects a body that does not match its signed digest', async () => {
    const { keys, prover, verifier } = await setup({ components: ['content-digest'] })
    void keys
    const signed = await prover.prove(
      new Request(url, { method: 'POST', body: 'original' }),
      context(),
    )
    const swapped = new Request(signed.url, {
      body: 'swapped',
      headers: signed.headers,
      method: 'POST',
    })
    expect(await verifier().verify(swapped)).toMatchInlineSnapshot(`
      {
        "reason": "The Content-Digest does not match the request body.",
        "status": "invalid",
      }
    `)
  })

  test('checks every supported digest present', async () => {
    const sha512 = Buffer.from(
      await crypto.subtle.digest('SHA-512', new TextEncoder().encode('body')),
    ).toString('base64')
    const wrong = Buffer.alloc(32).toString('base64')
    const ok = await signedPost('body', 'sha-512=:' + sha512 + ':')
    expect((await ok.verifier().verify(ok.signed)).status).toBe('valid')
    const mixed = await signedPost('body', 'sha-512=:' + sha512 + ':, sha-256=:' + wrong + ':')
    expect(await mixed.verifier().verify(mixed.signed)).toMatchObject({
      reason: 'The Content-Digest does not match the request body.',
    })
  })

  test.each([
    ['md5=:AAAAAAAAAAAAAAAAAAAAAA==:', 'The Content-Digest header has no supported digest.'],
    ['sha-256="not bytes"', 'The Content-Digest header is malformed.'],
    ['sha-256=:', 'The Content-Digest header is malformed.'],
  ])('rejects Content-Digest %s', async (digest, reason) => {
    const { signed, verifier } = await signedPost('body', digest)
    expect(await verifier().verify(signed)).toEqual({ reason, status: 'invalid' })
  })

  test('rejects a request whose body was already read', async () => {
    const { prover, verifier } = await setup({ components: ['content-digest'] })
    const signed = await prover.prove(new Request(url, { method: 'POST', body: 'body' }), context())
    await signed.text()
    expect(await verifier().verify(signed)).toMatchObject({
      reason: 'The request body is unavailable to check its Content-Digest.',
    })
  })

  test('keeps an existing Content-Digest header', async () => {
    const digest =
      'sha-256=:' +
      Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x'))).toString(
        'base64',
      ) +
      ':'
    const request = new Request(url, {
      method: 'POST',
      body: 'x',
      headers: { 'Content-Digest': digest },
    })
    expect(await HttpMessageSignature.withContentDigest(request)).toBe(request)
  })
})

describe('several signatures', () => {
  test('rejects a request carrying two TAP signatures', async () => {
    const { keys, prover, verifier } = await setup()
    const first = await prover.prove(new Request(url), context())
    const second = await Tap.Client.prover({
      intent: 'browse',
      key: keys,
      keyId: 'agent',
      label: 'tap2',
      scope: '*',
    }).prove(first, context())
    expect(await verifier().verify(second)).toMatchInlineSnapshot(`
      {
        "reason": "More than one matching HTTP message signature was provided.",
        "status": "invalid",
      }
    `)
  })

  test('ignores a signature with another tag', async () => {
    const { keys, prover, verifier } = await setup()
    const other = await HttpMessageSignature.sign(new Request(url), {
      components: ['@authority'],
      context: context(),
      key: keys,
      keyId: 'other',
      label: 'other',
      tag: 'web-bot-auth',
    })
    expect((await verifier().verify(await prover.prove(other, context()))).status).toBe('valid')
  })
})

describe('review fixes', () => {
  const digest = 'sha-256=:' + Buffer.alloc(32).toString('base64') + ':'

  async function signCovering(component: HttpMessageSignature.ComponentInput, request: Request) {
    const keys = await keyPair()
    const signed = await HttpMessageSignature.sign(request, {
      components: ['@authority', '@path', component],
      context: context(),
      key: keys,
      keyId: 'agent',
      label: 'tap',
      tag: 'agent-payer-auth',
    })
    return { keys, signed }
  }

  test('rejects a signature that covers only one Content-Digest member', async () => {
    const body = 'body'
    const real =
      'sha-256=:' +
      Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString(
        'base64',
      ) +
      ':'
    const { keys, signed } = await signCovering(
      { id: 'content-digest', parameters: new Map([['key', 'md5']]) },
      new Request(url, {
        body,
        headers: { 'Content-Digest': 'md5=:AAAAAAAAAAAAAAAAAAAAAA==:, ' + real },
        method: 'POST',
      }),
    )
    const strict = Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Store.memory(),
      requiredComponents: { payment: ['content-digest'] },
    })
    expect(await strict.verify(signed.clone())).toEqual({
      reason: 'The signature does not cover the components this verifier requires.',
      status: 'invalid',
    })
    const plain = Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Store.memory(),
    })
    expect(await plain.verify(signed)).toEqual({
      reason: 'The signature must cover the whole Content-Digest field.',
      status: 'invalid',
    })
  })

  test('rejects a body that fails while it is read', async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error('aborted'))
      },
    })
    const { keys, signed } = await signCovering(
      'content-digest',
      new Request(url, {
        body: stream,
        duplex: 'half',
        headers: { 'Content-Digest': digest },
        method: 'POST',
      } as RequestInit),
    )
    const verifier = Tap.Server.verifier({
      keyResolver: () => keys.publicKey,
      nonceStore: Store.memory(),
    })
    expect(await verifier.verify(signed)).toEqual({
      reason: 'The request body could not be read to check its Content-Digest.',
      status: 'invalid',
    })
  })
})
