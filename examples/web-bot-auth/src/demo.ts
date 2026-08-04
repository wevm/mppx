import { createBotClient, jwkThumbprint } from './client.js'
import { createPaymentHandler, listen } from './server.js'

const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const signatureAgent = 'https://bot.example'
const keyId = await jwkThumbprint(keys.publicKey)

const server = await listen(
  createPaymentHandler({
    expectedKeyId: keyId,
    expectedSignatureAgent: signatureAgent,
    publicKey: keys.publicKey,
  }),
)

try {
  const client = createBotClient({
    keyId,
    privateKey: keys.privateKey,
    signatureAgent,
  })
  client.onChallengeReceived(({ challenge }) => {
    console.log(`challenge.received ${challenge.method}/${challenge.intent}`)
  })
  client.onCredentialCreated(({ method }) => {
    console.log(`credential.created ${method.name}/${method.intent}`)
  })
  client.onPaymentResponse(({ response }) => {
    console.log(`payment.response ${response.status}`)
  })

  const response = await client.fetch(`${server.url}/protected`)

  console.log(response.status, await response.json())
} finally {
  await server.close()
}
