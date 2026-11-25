import { expect, test } from 'vp/test'
import { keyPair, remoteSigner } from '~test/Identity.js'

import * as Store from '../../../Store.js'
import * as Tap from '../tap/server/index.js'
import * as WebBotAuth from '../web-bot-auth/server/index.js'
import * as HttpMessageSignature from './HttpMessageSignature.js'

const emptySignature = Buffer.from(new Uint8Array(64)).toString('base64')

function tapRequest(components: string) {
  const created = Math.floor(Date.now() / 1_000) - 1
  return new Request('https://merchant.example/resource', {
    headers: {
      'Signature-Input': `test=(${components});created=${created};expires=${created + 60};keyid="agent";alg="ed25519";nonce="n";tag="agent-browser-auth"`,
      Signature: `test=:${emptySignature}:`,
    },
  })
}

test.each([
  ['a duplicate component', '"@authority" "@path" "@path"'],
  ['@signature-params as a component', '"@authority" "@path" "@signature-params"'],
])('TAP verification rejects %s as malformed', async (_, components) => {
  const keys = await keyPair()
  const result = await Tap.verifier({
    keyResolver: () => keys.publicKey,
    nonceStore: Store.memory(),
  }).verify(tapRequest(components))
  expect(result).toMatchInlineSnapshot(`
    {
      "reason": "The HTTP message signature is malformed.",
      "status": "invalid",
    }
  `)
})

test.each(['@path', '@signature-params'])(
  'signing refuses %s repeated or covered before calling a remote signer',
  async (component) => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    await expect(
      HttpMessageSignature.sign(new Request('https://merchant.example/resource'), {
        components: ['@authority', '@path', component],
        key: remoteSigner(keys, { calls }),
        keyId: 'agent',
        label: 'test',
        tag: 'agent-browser-auth',
      }),
    ).rejects.toThrow('Covered components must be unique and must not include "@signature-params".')
    expect(calls).toHaveLength(0)
  },
)

test('Web Bot Auth verification rejects ECDSA before resolving a key', async () => {
  const created = Math.floor(Date.now() / 1_000) - 1
  let resolved = false
  const request = new Request('https://merchant.example/resource', {
    headers: {
      'Signature-Agent': 'webbot="https://agent.example"',
      'Signature-Input': `webbot=("@authority" "signature-agent";key="webbot");created=${created};expires=${created + 60};keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ecdsa-p256-sha256";nonce="n";tag="web-bot-auth"`,
      Signature: `webbot=:${emptySignature}:`,
    },
  })
  const result = await WebBotAuth.verifier({
    keyResolver: () => {
      resolved = true
      return undefined
    },
    nonceStore: Store.memory(),
  }).verify(request)
  expect(resolved).toBe(false)
  expect(result).toMatchInlineSnapshot(`
    {
      "reason": "The signature algorithm is not supported.",
      "status": "invalid",
    }
  `)
})
