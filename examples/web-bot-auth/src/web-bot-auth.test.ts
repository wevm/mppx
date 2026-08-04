import assert from 'node:assert/strict'
import test from 'node:test'

import * as Attestation from 'mppx/attestation'

import { createBotSigner, jwkThumbprint } from './client.js'
import { createProtectedHandler } from './server.js'

test('requires a Web Bot Auth signature', async () => {
  const fixture = await createFixture()
  const response = await fixture.handler(new Request('https://merchant.example/protected'))

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    authenticated: false,
    reason: 'A Web Bot Auth signature is required.',
    status: 'absent',
  })
})

test('authenticates a trusted bot and rejects a replayed signature', async () => {
  const fixture = await createFixture()
  const signer = createBotSigner({
    keyId: fixture.keyId,
    privateKey: fixture.privateKey,
    signatureAgent: fixture.signatureAgent,
  })
  const signed = await signer.sign(new Request('https://merchant.example/protected'))

  const accepted = await fixture.handler(signed.clone())
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), {
    authenticated: true,
    bot: {
      keyId: fixture.keyId,
      signatureAgent: fixture.signatureAgent,
    },
  })

  const replayed = await fixture.handler(signed.clone())
  assert.equal(replayed.status, 401)
  assert.equal((await replayed.json()).status, 'invalid')
})

test('does not authenticate an untrusted signature agent', async () => {
  const fixture = await createFixture()
  const signed = await createBotSigner({
    keyId: fixture.keyId,
    privateKey: fixture.privateKey,
    signatureAgent: 'https://untrusted.example',
  }).sign(new Request('https://merchant.example/protected'))

  const response = await fixture.handler(signed)

  assert.equal(response.status, 401)
  assert.equal((await response.json()).status, 'unverified')
})

async function createFixture() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const keyId = await jwkThumbprint(keys.publicKey)
  const signatureAgent = 'https://bot.example'
  const handler = createProtectedHandler({
    expectedKeyId: keyId,
    expectedSignatureAgent: signatureAgent,
    nonceStore: Attestation.NonceStore.memory(),
    publicKey: keys.publicKey,
  })

  return { handler, keyId, privateKey: keys.privateKey, signatureAgent }
}
