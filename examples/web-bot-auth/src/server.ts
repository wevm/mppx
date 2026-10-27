import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import * as Identity from 'mppx/identity'
import { Mppx, tempo } from 'mppx/server'

export type ServerConfig = {
  keyId: string
  nonceStore?: Identity.Store.AtomicStore
  publicKey: CryptoKey
  recipient: `0x${string}`
  secretKey: string
  signatureAgent: string
}

/** Creates an Mppx server and the Web Bot Auth verifier its protected routes require. */
export function createServer(config: ServerConfig) {
  const webBotAuth = WebBotAuth.Server.verifier({
    keyResolver({ keyId, signatureAgent }) {
      if (keyId !== config.keyId || signatureAgent !== config.signatureAgent) return undefined
      return config.publicKey
    },
    maxAge: 60,
    nonceStore: config.nonceStore ?? Identity.Store.memory(),
  })
  const mppx = Mppx.create({
    methods: [
      tempo({
        recipient: config.recipient,
        testnet: true,
      }),
    ],
    secretKey: config.secretKey,
  })
  return {
    mppx,
    /** Charges for a route that only trusted bots may call. */
    charge: (amount: string) => mppx.charge({ amount, identity: [webBotAuth] }),
    webBotAuth,
  }
}
