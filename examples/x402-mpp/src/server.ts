import { createServer } from 'node:http'

import { NodeListener, Request as ServerRequest } from 'mppx/server'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'

import { createApp, createTempoClient } from './app.js'

const port = Number(process.env.PORT ?? 5173)
const privateKey = process.env.MPPX_PRIVATE_KEY as `0x${string}` | undefined
const account = privateKeyToAccount(privateKey ?? generatePrivateKey())
const tempoClient = createTempoClient()

if (process.env.MPPX_SKIP_FAUCET !== 'true') await Actions.faucet.fundSync(tempoClient, { account })

const app = createApp({
  account,
  getTempoClient: () => tempoClient,
})

const server = createServer(async (req, res) => {
  const request = ServerRequest.fromNodeListener(req, res)
  const response = await app.fetch(request)
  return NodeListener.sendResponse(res, response)
})

server.listen(port)

console.log(`x402 + mpp example listening on http://localhost:${port}`)
console.log(`mpp route: pnpm mppx http://localhost:${port}/api/mpp`)
console.log(`x402 route: curl -i http://localhost:${port}/api/x402`)
console.log(`composed route: http://localhost:${port}/api/paid`)
