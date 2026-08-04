import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as Attestation from 'mppx/attestation'
import * as WebBotAuth from 'mppx/attestation/web-bot-auth'
import { Request as ServerRequest } from 'mppx/server'

type NonceStore = Parameters<typeof WebBotAuth.Server.verifier>[0]['nonceStore']

export type ServerConfig = {
  expectedKeyId: string
  expectedSignatureAgent: string
  nonceStore?: NonceStore
  publicKey: CryptoKey
}

/** Creates a Fetch API handler protected by a trusted Web Bot Auth identity. */
export function createProtectedHandler(config: ServerConfig) {
  const verifier = WebBotAuth.Server.verifier({
    keyResolver({ algorithm, keyId, signatureAgent }) {
      if (
        algorithm !== Attestation.Algorithms.ed25519 ||
        keyId !== config.expectedKeyId ||
        signatureAgent !== config.expectedSignatureAgent
      )
        return undefined
      return config.publicKey
    },
    maxAge: 60,
    nonceStore: config.nonceStore ?? Attestation.NonceStore.memory(),
  })

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/protected') return new Response('Not found.', { status: 404 })

    const { webBotAuth } = await Attestation.Server.verify(request, { webBotAuth: verifier })
    if (webBotAuth.status !== 'verified')
      return Response.json(
        {
          authenticated: false,
          reason:
            'reason' in webBotAuth ? webBotAuth.reason : 'A Web Bot Auth signature is required.',
          status: webBotAuth.status,
        },
        { status: 401 },
      )

    return Response.json({
      authenticated: true,
      bot: {
        keyId: webBotAuth.value.keyId,
        signatureAgent: webBotAuth.value.signatureAgent,
      },
    })
  }
}

/** Starts a local Node.js server for the protected Fetch API handler. */
export async function listen(
  handler: ReturnType<typeof createProtectedHandler>,
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
