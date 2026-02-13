import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, '.'))

  return {
    plugins: [
      {
        name: 'api',
        async configureServer(server) {
          const { handler } = await import('./src/server.ts')
          server.middlewares.use(async (req, res, next) => {
            const request = createRequest(req, res)
            const response = await handler(request)
            if (response) await sendResponse(res, response)
            else next()
          })
        },
      },
    ],
  }
})
