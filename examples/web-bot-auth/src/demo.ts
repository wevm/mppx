import { createBotFetch, jwkThumbprint } from './client.js'
import { createProtectedHandler, listen } from './server.js'

const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const signatureAgent = 'https://bot.example'
const keyId = await jwkThumbprint(keys.publicKey)

const server = await listen(
  createProtectedHandler({
    expectedKeyId: keyId,
    expectedSignatureAgent: signatureAgent,
    publicKey: keys.publicKey,
  }),
)

try {
  const response = await createBotFetch({
    keyId,
    privateKey: keys.privateKey,
    signatureAgent,
  })(`${server.url}/protected`)

  console.log(response.status, await response.json())
} finally {
  await server.close()
}
