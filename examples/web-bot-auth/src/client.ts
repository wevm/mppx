import { Mppx, tempo } from 'mppx/client'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import type { Account } from 'viem'

export type ClientConfig = {
  account: Account
  key: CryptoKey
  keyId: string
  /** Origins that receive Web Bot Auth signatures. */
  scope: readonly string[]
  signatureAgent: string
}

/** Creates an Mppx client that signs every in-scope HTTP attempt with Web Bot Auth. */
export function createClient(config: ClientConfig) {
  return Mppx.create({
    identity: [
      WebBotAuth.Client.prover({
        key: config.key,
        keyId: config.keyId,
        scope: config.scope,
        signatureAgent: config.signatureAgent,
      }),
    ],
    methods: [tempo({ account: config.account })],
    polyfill: false,
  })
}
