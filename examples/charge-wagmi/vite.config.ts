import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api',
      async configureServer(server) {
        const { handler } = await import('./server.ts')
        server.middlewares.use(async (req, res, next) => {
          const request = createRequest(req, res)
          const response = await handler(request)
          if (response) await sendResponse(res, response)
          else next()
        })
      },
    },
  ],
})
