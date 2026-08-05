import * as Attestation from 'mppx/attestation'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Mppx, tempo } from 'mppx/server'

type AtomicStore = Parameters<typeof WebBotAuth.Server.verifier>[0]['nonceStore']

export type ServerConfig = {
  keyId: string
  nonceStore?: AtomicStore
  publicKey: CryptoKey
  recipient: `0x${string}`
  secretKey: string
  signatureAgent: string
}

/** Creates an Mppx server protected by a trusted Web Bot Auth identity. */
export function createServer(config: ServerConfig) {
  return Mppx.create({
    attestation: {
      webBotAuth: WebBotAuth.Server.verifier({
        keyResolver({ keyId, signatureAgent }) {
          if (keyId !== config.keyId || signatureAgent !== config.signatureAgent) return undefined
          return config.publicKey
        },
        maxAge: 60,
        nonceStore: config.nonceStore ?? Attestation.Store.memory(),
      }),
    },
    methods: [
      tempo({
        recipient: config.recipient,
        testnet: true,
      }),
    ],
    secretKey: config.secretKey,
  })
}
