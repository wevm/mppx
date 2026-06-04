import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'

import { handler } from './src/server.ts'

export default defineConfig({
  plugins: [
    {
      name: 'playground-api',
      configureServer(server) {
        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(async (req, res, next) => {
          try {
            const request = createRequest(req, res)
            const response = await handler(request)
            if (response) {
              await sendResponse(res, response)
              return
            }
            next()
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (res.headersSent) {
              console.error(message)
              return
            }
            await sendResponse(res, Response.json({ error: message }, { status: 500 }))
          }
        })

        server.httpServer?.once('listening', () => {
          const addr = server.httpServer!.address()
          const host =
            typeof addr === 'object' && addr ? `localhost:${addr.port}` : 'localhost:5173'
          setTimeout(() => {
            console.log('\n  Tempo session playground:')
            console.log(`  http://${host}/\n`)
          }, 100)
        })
      },
    },
  ],
})
