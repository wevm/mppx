import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

const startupLogDelayMs = 100

export default defineConfig({
  plugins: [apiPlugin()],
})

function apiPlugin(): Plugin {
  return {
    name: 'api',
    async configureServer(server) {
      const { handler } = await import('./src/server.ts')
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
  const address = server.httpServer?.address()
  const host =
    typeof address === 'object' && address ? `localhost:${address.port}` : 'localhost:5173'
  setTimeout(() => {
    console.log(`\n  Open http://${host}/`)
    console.log(`  POST authorizations with: npx mppx http://${host}/api/authorizations?amount=1\n`)
  }, startupLogDelayMs)
}
