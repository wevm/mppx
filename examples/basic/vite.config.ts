import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'
import { handler } from './src/server.ts'

export default defineConfig({
  plugins: [
    {
      name: 'api',
      configureServer(server) {
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
