import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair } from '~test/Attestation.js'

test('returns typed protocol outcomes and namespaces shared nonces', async () => {
  const keys = await keyPair()
  const keyId = await jwkThumbprint(keys.publicKey)
  const signatureAgent = 'https://agent.example'
  const signed = await Attestation.Client.composeSigners(
    WebBotAuth.Client.signer({ key: keys.privateKey, keyId, signatureAgent }),
    Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: keys.privateKey,
      keyId,
    }),
  ).sign(new Request('https://merchant.example/resource'))
  const consumed = new Set<string>()
  const backing = Attestation.Store.memory()
  const nonceStore: Attestation.Store.AtomicStore = {
    ...backing,
    tryClaim(key, expires) {
      consumed.add(key)
      return Attestation.Store.tryClaim(backing, key, expires)
    },
  }
  const verifiers = {
    tap: Tap.Server.verifier({
      keyResolver: ({ keyId: candidate }) => (candidate === keyId ? keys.publicKey : undefined),
      nonceStore,
    }),
    webBotAuth: WebBotAuth.Server.verifier({
      keyResolver: ({ keyId: candidate, signatureAgent: candidateAgent }) =>
        candidate === keyId && candidateAgent === signatureAgent ? keys.publicKey : undefined,
      nonceStore,
    }),
  }

  const verified = await Attestation.Server.verify(signed, verifiers)
  expect(verified.tap).toMatchObject({
    status: 'verified',
    value: { intent: Tap.Constants.intents.payment, keyId },
  })
  expect(verified.webBotAuth).toMatchObject({
    status: 'verified',
    value: { keyId, signatureAgent },
  })
  expect([...consumed].some((value) => value.startsWith(`${Tap.Constants.protocol}:`))).toBe(true)
  expect([...consumed].some((value) => value.startsWith(`${WebBotAuth.Constants.protocol}:`))).toBe(
    true,
  )

  const replay = await Attestation.Server.verify(signed, verifiers)
  for (const outcome of Object.values(replay))
    expect(outcome).toEqual({
      reason: 'The signature nonce has already been used.',
      status: 'invalid',
    })
})
