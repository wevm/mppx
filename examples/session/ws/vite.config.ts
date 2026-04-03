import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'

import { handleUpgrade, handler } from './src/server.ts'

export default defineConfig({
  plugins: [
    {
      name: 'api',
      configureServer(server) {
        server.httpServer?.on('upgrade', handleUpgrade)

        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(async (req, res, next) => {
          const request = createRequest(req, res)
          const response = await handler(request)
          if (response) await sendResponse(res, response)
          else next()
        })

        server.httpServer?.once('listening', () => {
          const addr = server.httpServer!.address()
          const host =
            typeof addr === 'object' && addr ? `localhost:${addr.port}` : 'localhost:5173'
          setTimeout(() => {
            console.log(`\n  WebSocket demo:`)
            console.log(`  pnpm --dir examples/session/ws client`)
            console.log(`  ws://${host}/ws/chat\n`)
          }, 100)
        })
      },
    },
  ],
})
