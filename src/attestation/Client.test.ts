import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { expect, test } from 'vp/test'
import { jwkThumbprint, keyPair } from '~test/Attestation.js'

test('shares one immutable context and composes signature dictionaries', async () => {
  const tapKeys = await keyPair()
  const webBotAuthKeys = await keyPair()
  const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
  const tapSigner = Tap.Client.signer({
    intent: Tap.Constants.intents.payment,
    key: tapKeys.privateKey,
    keyId: 'tap-agent',
  })
  const webBotAuthSigner = WebBotAuth.Client.signer({
    key: webBotAuthKeys.privateKey,
    keyId: webBotAuthKeyId,
    signatureAgent: 'https://agent.example',
  })

  for (const signers of [
    [webBotAuthSigner, tapSigner],
    [tapSigner, webBotAuthSigner],
  ] as const) {
    const contexts: Attestation.SigningContext[] = []
    const observingSigners = signers.map((signer) => ({
      ...signer,
      sign(request: Request, context?: Attestation.SigningContext) {
        if (context) contexts.push(context)
        return signer.sign(request, context)
      },
    })) as [Attestation.Signer, Attestation.Signer]
    const signed = await Attestation.Client.composeSigners(...observingSigners).sign(
      new Request('https://merchant.example/resource'),
    )

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toBe(contexts[1])
    expect(Object.isFrozen(contexts[0])).toBe(true)
    const input = signed.headers.get(Attestation.Headers.signatureInput) ?? ''
    const signature = signed.headers.get(Attestation.Headers.signature) ?? ''
    expect(input).toContain(`${WebBotAuth.Constants.label}=`)
    expect(input).toContain(`${Tap.Constants.label}=`)
    expect(signature).toContain(`${WebBotAuth.Constants.label}=`)
    expect(signature).toContain(`${Tap.Constants.label}=`)
  }
})

test('rejects duplicate and mismatched signature labels', async () => {
  const tapKeys = await keyPair()
  const webBotAuthKeys = await keyPair()
  const webBotAuthKeyId = await jwkThumbprint(webBotAuthKeys.publicKey)
  const signer = Attestation.Client.composeSigners(
    WebBotAuth.Client.signer({
      key: webBotAuthKeys.privateKey,
      keyId: webBotAuthKeyId,
      label: 'agent',
      signatureAgent: 'https://agent.example',
    }),
    Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: tapKeys.privateKey,
      keyId: 'tap-agent',
      label: 'agent',
    }),
  )

  await expect(signer.sign(new Request('https://merchant.example/resource'))).rejects.toThrow(
    'HTTP message signature label "agent" already exists.',
  )
  await expect(
    Tap.Client.signer({
      intent: Tap.Constants.intents.payment,
      key: tapKeys.privateKey,
      keyId: 'tap-agent',
    }).sign(
      new Request('https://merchant.example/resource', {
        headers: { [Attestation.Headers.signatureInput]: 'orphan=("@authority")' },
      }),
    ),
  ).rejects.toThrow('Signature-Input and Signature must contain the same labels.')
})
