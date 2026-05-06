import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

import { handler } from './src/server.ts'

const startupLogDelayMs = 100

export default defineConfig({
  plugins: [apiPlugin()],
})

function apiPlugin(): Plugin {
  return {
    name: 'api',
    configureServer(server) {
      // oxlint-disable-next-line no-async-endpoint-handlers
      server.middlewares.use(async (req, res, next) => {
        const request = createRequest(req, res)
        const response = await handler(request)
        if (response) await sendResponse(res, response)
        else next()
      })
      server.httpServer?.once('listening', () => logStartup(server))
    },
  }
}

function logStartup(server: ViteDevServer) {
  const host = getServerHost(server)
  const packageRunner = getPackageRunner()
  setTimeout(() => {
    console.log(`  ${packageRunner} mppx http://${host}/api/article`)
    console.log('  pnpm client')
  }, startupLogDelayMs)
}

function getServerHost(server: ViteDevServer) {
  const address = server.httpServer?.address()
  return typeof address === 'object' && address ? `localhost:${address.port}` : 'localhost:5173'
}

function getPackageRunner() {
  const packageManager = process.env.npm_config_user_agent?.split('/')[0]
  return packageManager === 'npm' || !packageManager ? 'npx' : packageManager
}
