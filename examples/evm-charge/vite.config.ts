import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
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
      },
    },
  ],
  server: {
    port: 5178,
  },
})
