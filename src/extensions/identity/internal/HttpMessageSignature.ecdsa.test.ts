import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

import { isInnerList, parseDictionary } from 'structured-headers'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import * as TapClient from '../tap/client/index.js'
import * as TapServer from '../tap/server/index.js'
import * as WebBotAuth from '../web-bot-auth/client/index.js'
import * as WebBotAuthServer from '../web-bot-auth/server/index.js'
import * as HttpMessageSignature from './HttpMessageSignature.js'

describe.each([
  ['P-256', 'ecdsa-p256-sha256', 'sha256', 64],
  ['P-384', 'ecdsa-p384-sha384', 'sha384', 96],
] as const)('%s HTTP message signatures', (curve, algorithm, hash, length) => {
  async function keys() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
      'sign',
      'verify',
    ])
    const privateKey = createPrivateKey({
      key: Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
      format: 'der',
      type: 'pkcs8',
    })
    return { pair, privateKey, publicKey: createPublicKey(privateKey) }
  }

  test('signs locally and remotely using the RFC hash and fixed-width r || s encoding', async () => {
    const { pair, privateKey, publicKey } = await keys()
    const remote = {
      publicKey: pair.publicKey,
      async sign({ payload }: { readonly payload: Uint8Array }) {
        return sign(hash, payload, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      },
    }
    for (const key of [pair, remote]) {
      const signed = await TapClient.prover({
        key,
        keyId: 'agent',
        intent: 'browse',
        scope: '*',
      }).prove(new Request(url), context())
      const input = signed.headers.get('Signature-Input')!.slice('tap='.length)
      expect(input).toContain(`alg="${algorithm}"`)
      const entry = parseDictionary(signed.headers.get('Signature')!).get('tap')!
      if (isInnerList(entry) || !(entry[0] instanceof ArrayBuffer))
        throw new Error('Expected a signature byte sequence.')
      const signature = Buffer.from(entry[0])
      expect(signature).toHaveLength(length)
      expect(
        verify(
          hash,
          Buffer.from(base(input)),
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          signature,
        ),
      ).toBe(true)
      expect(await verifier(pair.publicKey).verify(signed)).toMatchObject({ status: 'valid' })
    }
  })

  test('verifies an independently signed request and rejects replay and tampering', async () => {
    const { pair, privateKey } = await keys()
    const request = external(privateKey, hash)
    const check = verifier(pair.publicKey)
    expect(await check.verify(request)).toMatchObject({ status: 'valid' })
    expect(await check.verify(request)).toMatchObject({
      status: 'invalid',
      reason: 'The signature nonce has already been used.',
    })
    expect(
      await verifier(pair.publicKey).verify(
        new Request('https://merchant.example/changed', { headers: request.headers }),
      ),
    ).toMatchObject({ status: 'invalid' })
  })

  test('rejects a signature made with the wrong hash', async () => {
    const { pair, privateKey } = await keys()
    expect(
      await verifier(pair.publicKey).verify(
        external(privateKey, hash === 'sha256' ? 'sha384' : 'sha256'),
      ),
    ).toMatchObject({ status: 'invalid', reason: 'The HTTP message signature is invalid.' })
  })

  test('checks the key curve against the declared algorithm', async () => {
    const { privateKey } = await keys()
    const wrong = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: curve === 'P-256' ? 'P-384' : 'P-256' },
      true,
      ['sign', 'verify'],
    )
    expect(await verifier(wrong.publicKey).verify(external(privateKey, hash))).toMatchObject({
      status: 'invalid',
      reason: 'The public key does not support the signature algorithm.',
    })
  })

  test('rejects DER-encoded request signatures', async () => {
    const { pair, privateKey } = await keys()
    expect(await verifier(pair.publicKey).verify(external(privateKey, hash, 'der'))).toMatchObject({
      status: 'invalid',
      reason: 'The HTTP message signature is invalid.',
    })
  })

  test('rejects a remote signer returning DER instead of raw r || s', async () => {
    const { pair, privateKey } = await keys()
    const key = {
      publicKey: pair.publicKey,
      async sign({ payload }: { readonly payload: Uint8Array }) {
        return sign(hash, payload, { key: privateKey, dsaEncoding: 'der' })
      },
    }
    await expect(
      TapClient.prover({ key, keyId: 'agent', intent: 'browse', scope: '*' }).prove(
        new Request(url),
        context(),
      ),
    ).rejects.toThrow('The Signer returned a signature that does not verify with its publicKey.')
  })

  test('keeps the Web Bot Auth prover restricted to its existing algorithms', async () => {
    const { pair } = await keys()
    expect(() =>
      WebBotAuth.prover({ key: pair, signatureAgent: 'https://agent.example', scope: '*' }),
    ).toThrow('Signing keys must be Ed25519 or RSA-PSS SHA-512.')
  })

  test('keeps the Web Bot Auth verifier restricted to its existing key types', async () => {
    const { pair } = await keys()
    const signed = await HttpMessageSignature.sign(
      new Request(url, { headers: { 'Signature-Agent': 'agent="https://agent.example"' } }),
      {
        components: [
          '@authority',
          { id: 'signature-agent', parameters: new Map([['key', 'agent']]) },
        ],
        key: pair,
        keyId: 'A'.repeat(43),
        label: 'agent',
        tag: 'web-bot-auth',
      },
    )
    expect(
      await WebBotAuthServer.verifier({
        keyResolver: () => pair.publicKey,
        nonceStore: Store.memory(),
      }).verify(signed),
    ).toMatchObject({
      status: 'invalid',
      reason: 'The Web Bot Auth key must be an extractable Ed25519 or RSA public key.',
    })
  })

  function external(
    privateKey: ReturnType<typeof createPrivateKey>,
    signingHash: string,
    dsaEncoding: 'der' | 'ieee-p1363' = 'ieee-p1363',
  ) {
    const { created, nonce } = context()
    const input = `("@authority" "@path");created=${created};expires=${created + 60};keyid="agent";alg="${algorithm}";nonce="${nonce}";tag="agent-browser-auth"`
    const signature = sign(signingHash, Buffer.from(base(input)), { key: privateKey, dsaEncoding })
    return new Request(url, {
      headers: {
        'Signature-Input': `external=${input}`,
        Signature: `external=:${signature.toString('base64')}:`,
      },
    })
  }
})

test('rejects a key pair whose halves use different ECDSA curves', async () => {
  const [p256, p384] = await Promise.all(
    ['P-256', 'P-384'].map((namedCurve) =>
      crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']),
    ),
  )
  expect(() =>
    TapClient.prover({
      key: { publicKey: p256!.publicKey, privateKey: p384!.privateKey },
      keyId: 'agent',
      intent: 'browse',
      scope: '*',
    }),
  ).toThrow('The privateKey and publicKey of a signing key pair use different algorithms.')
})

const url = 'https://merchant.example/resource'

function base(input: string) {
  return [
    '"@authority": merchant.example',
    '"@path": /resource',
    `"@signature-params": ${input}`,
  ].join('\n')
}

function context() {
  return { created: Math.floor(Date.now() / 1_000), nonce: crypto.randomUUID() }
}

function verifier(publicKey: CryptoKey) {
  return TapServer.verifier({ keyResolver: () => publicKey, nonceStore: Store.memory() })
}
