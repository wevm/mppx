import { expect, test } from 'vp/test'
import { keyPair, remoteSigner } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import * as Tap from '../tap/server/index.js'
import * as HttpMessageSignature from './HttpMessageSignature.js'

test.each([
  ['@method', 'https://merchant.example/resource', 'customMethod', 'customMethod'],
  ['@scheme', 'HTTPS://merchant.example/resource', 'GET', 'https'],
  ['@query', 'https://merchant.example/resource', 'GET', '?'],
  ['@query', 'https://merchant.example/resource?', 'GET', '?'],
  ['@query', 'https://merchant.example/resource?a=1&a=2', 'GET', '?a=1&a=2'],
  ['@query', 'https://merchant.example/resource?q=a%2fb+c%20d', 'GET', '?q=a%2fb+c%20d'],
])('signs %s from %s with method %s', async (component, url, method, value) => {
  const keys = await keyPair()
  const calls: Uint8Array[] = []
  const signed = await HttpMessageSignature.sign(new Request(url, { method }), {
    components: ['@authority', '@path', component],
    key: remoteSigner(keys, { calls }),
    keyId: 'agent',
    label: 'test',
    tag: 'agent-browser-auth',
  })
  expect(calls).toHaveLength(1)
  expect(new TextDecoder().decode(calls[0])).toBe(
    [
      '"@authority": merchant.example',
      '"@path": /resource',
      `"${component}": ${value}`,
      `"@signature-params": ${signed.headers.get('Signature-Input')!.slice('test='.length)}`,
    ].join('\n'),
  )
  expect(await verifier(keys.publicKey).verify(signed)).toMatchObject({ status: 'valid' })
})

test.each(['@method', '@scheme', '@query'])(
  'rejects unsupported parameters on %s before calling a remote signer',
  async (id) => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example'), {
        components: [{ id, parameters: new Map([['req', true]]) }],
        key: remoteSigner(keys, { calls }),
        keyId: 'agent',
        label: 'test',
        tag: 'agent-browser-auth',
      }),
    ).rejects.toThrow(`Unsupported parameters for "${id}".`)
    expect(calls).toHaveLength(0)
  },
)

test('verifies an external TAP signature covering additional request components and headers', async () => {
  const keys = await keyPair()
  const created = Math.floor(Date.now() / 1_000)
  const digest = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('payload')),
  ).toString('base64')
  const components = [
    ['@method', 'POST'],
    ['@scheme', 'https'],
    ['@authority', 'merchant.example'],
    ['@path', '/resource'],
    ['@query', '?q=a%2fb+c%20d&a=1&a=2'],
    ['authorization', 'Payment test'],
    ['content-digest', `sha-256=:${digest}:`],
  ] as const
  // Build and sign independently, so a shared signer/verifier mistake cannot pass this test.
  const input = `(${components.map(([id]) => `"${id}"`).join(' ')});created=${created};expires=${created + 60};keyid="agent";alg="ed25519";nonce="external-request";tag="agent-payer-auth"`
  const base = [
    ...components.map(([id, value]) => `"${id}": ${value}`),
    `"@signature-params": ${input}`,
  ].join('\n')
  const signature = await crypto.subtle.sign(
    'Ed25519',
    keys.privateKey,
    new TextEncoder().encode(base),
  )
  const url = 'https://merchant.example/resource?q=a%2fb+c%20d&a=1&a=2'
  const headers = new Headers({
    Authorization: 'Payment test',
    'Content-Digest': `sha-256=:${digest}:`,
    'Signature-Input': `external=${input}`,
    Signature: `external=:${Buffer.from(signature).toString('base64')}:`,
  })
  const request = new Request(url, { method: 'POST', headers, body: 'payload' })
  const verify = verifier(keys.publicKey)
  expect(await verify.verify(request)).toMatchObject({
    status: 'valid',
    value: { intent: 'payment' },
  })
  expect(await verify.verify(request)).toMatchObject({
    status: 'invalid',
    reason: 'The signature nonce has already been used.',
  })

  for (const changed of [
    new Request(url, { method: 'PUT', headers }),
    new Request(url.replace('https:', 'http:'), { method: 'POST', headers }),
    new Request(url.replace('merchant.example', 'other.example'), { method: 'POST', headers }),
    new Request(url.replace('/resource', '/other'), { method: 'POST', headers }),
    new Request(url.replace('a=1&a=2', 'a=2&a=1'), { method: 'POST', headers }),
    new Request(url.replace('%2f', '%2F'), { method: 'POST', headers }),
    new Request(url.replace('a%2fb+c%20d', 'a%2fb%20c%20d'), { method: 'POST', headers }),
  ])
    expect(await verifier(keys.publicKey).verify(changed)).toMatchObject({ status: 'invalid' })
  for (const name of ['Authorization', 'Content-Digest']) {
    const changed = new Headers(headers)
    changed.set(name, 'changed')
    expect(
      await verifier(keys.publicKey).verify(new Request(url, { method: 'POST', headers: changed })),
    ).toMatchObject({ status: 'invalid' })
  }
  const unsigned = new Headers(headers)
  unsigned.set('X-Unrelated', 'changed')
  expect(
    await verifier(keys.publicKey).verify(new Request(url, { method: 'POST', headers: unsigned })),
  ).toMatchObject({ status: 'valid' })
})

function verifier(publicKey: CryptoKey) {
  return Tap.verifier({ keyResolver: () => publicKey, nonceStore: Store.memory() })
}
