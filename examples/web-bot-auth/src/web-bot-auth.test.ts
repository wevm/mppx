import assert from 'node:assert/strict'
import test from 'node:test'

import { Receipt } from 'mppx'
import * as Attestation from 'mppx/attestation'

import { createBotClient, createBotSigner, jwkThumbprint } from './client.js'
import { createPaymentHandler, listen } from './server.js'

test('requires a Web Bot Auth signature', async () => {
  const fixture = await createFixture()
  const response = await fixture.handler(new Request('https://merchant.example/protected'))

  assert.equal(response.status, 403)
  assert.match(await response.text(), /webBotAuth.*required/)
})

test('attests the initial request and automatic MPP payment retry', async () => {
  const fixture = await createFixture()
  const server = await listen(fixture.handler)
  const client = createBotClient({
    keyId: fixture.keyId,
    privateKey: fixture.privateKey,
    signatureAgent: fixture.signatureAgent,
  })
  const events: string[] = []
  client.onChallengeReceived(({ challenge }) => {
    events.push(`challenge:${challenge.method}/${challenge.intent}`)
  })
  client.onCredentialCreated(({ method }) => {
    events.push(`credential:${method.name}/${method.intent}`)
  })
  client.onPaymentResponse(({ response }) => {
    events.push(`response:${response.status}`)
  })

  try {
    const response = await client.fetch(`${server.url}/protected`)

    assert.equal(response.status, 200)
    assert.equal(Receipt.fromResponse(response).method, 'demo')
    assert.deepEqual(await response.json(), {
      payment: 'paid',
    })
    assert.deepEqual(events, ['challenge:demo/charge', 'credential:demo/charge', 'response:200'])
    assert.equal(fixture.consumedNonces.length, 2)
    assert.equal(new Set(fixture.consumedNonces).size, 2)
  } finally {
    await server.close()
  }
})

test('rejects a replayed Web Bot Auth signature', async () => {
  const fixture = await createFixture()
  const signed = await createBotSigner({
    keyId: fixture.keyId,
    privateKey: fixture.privateKey,
    signatureAgent: fixture.signatureAgent,
  }).sign(new Request('https://merchant.example/protected'))

  const accepted = await fixture.handler(signed.clone())
  assert.equal(accepted.status, 402)
  const replayed = await fixture.handler(signed.clone())
  assert.equal(replayed.status, 401)
  assert.match(await replayed.text(), /webBotAuth.*invalid/)
})

test('does not authenticate an untrusted signature agent', async () => {
  const fixture = await createFixture()
  const signed = await createBotSigner({
    keyId: fixture.keyId,
    privateKey: fixture.privateKey,
    signatureAgent: 'https://untrusted.example',
  }).sign(new Request('https://merchant.example/protected'))

  const response = await fixture.handler(signed)

  assert.equal(response.status, 403)
  assert.match(await response.text(), /webBotAuth.*could not be verified/)
})

async function createFixture() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const keyId = await jwkThumbprint(keys.publicKey)
  const signatureAgent = 'https://bot.example'
  const consumedNonces: string[] = []
  const memoryNonceStore = Attestation.NonceStore.memory()
  const handler = createPaymentHandler({
    expectedKeyId: keyId,
    expectedSignatureAgent: signatureAgent,
    nonceStore: {
      consume(key, expires) {
        consumedNonces.push(key)
        return memoryNonceStore.consume(key, expires)
      },
    },
    publicKey: keys.publicKey,
  })

  return { consumedNonces, handler, keyId, privateKey: keys.privateKey, signatureAgent }
}
