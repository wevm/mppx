import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as Attestation from 'mppx/attestation'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Mppx, Request as ServerRequest } from 'mppx/server'

import { serverMethod } from './method.js'

type NonceStore = Parameters<typeof WebBotAuth.Server.verifier>[0]['nonceStore']

export type ServerConfig = {
  expectedKeyId: string
  expectedSignatureAgent: string
  nonceStore?: NonceStore
  publicKey: CryptoKey
}

/** Creates an MPP payment handler protected by a trusted Web Bot Auth identity. */
export function createPaymentHandler(config: ServerConfig) {
  const payments = Mppx.create({
    attestation: {
      webBotAuth: WebBotAuth.Server.verifier({
        keyResolver({ keyId, signatureAgent }) {
          if (keyId !== config.expectedKeyId || signatureAgent !== config.expectedSignatureAgent)
            return undefined
          return config.publicKey
        },
        maxAge: 60,
        nonceStore: config.nonceStore ?? Attestation.NonceStore.memory(),
      }),
    },
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'example-secret-key-example-secret-key',
  })
  const charge = payments.charge({ amount: '1', currency: 'USD', recipient: 'merchant' })

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/protected') return new Response('Not found.', { status: 404 })

    const result = await charge(request)
    if (result.status === 402) return result.challenge

    return result.withReceipt(
      Response.json({
        payment: 'paid',
      }),
    )
  }
}

/** Starts a local Node.js server for the protected Fetch API handler. */
export async function listen(
  handler: ReturnType<typeof createPaymentHandler>,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(ServerRequest.toNodeListener(handler))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address() as AddressInfo
  return {
    close: () => close(server),
    url: `http://127.0.0.1:${address.port}`,
  }
}

async function close(server: Server): Promise<void> {
  server.close()
  await once(server, 'close')
}
