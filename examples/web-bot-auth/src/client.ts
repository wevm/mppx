import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Mppx, tempo } from 'mppx/client'
import type { Account } from 'viem'

export type ClientConfig = {
  account: Account
  key: CryptoKey
  keyId: string
  signatureAgent: string
}

/** Creates an Mppx client that signs every HTTP attempt with Web Bot Auth. */
export function createClient(config: ClientConfig) {
  return Mppx.create({
    attestation: {
      webBotAuth: WebBotAuth.Client.signer({
        key: config.key,
        keyId: config.keyId,
        signatureAgent: config.signatureAgent,
      }),
    },
    methods: [tempo({ account: config.account })],
    polyfill: false,
  })
}
