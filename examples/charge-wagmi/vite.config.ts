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
        server.httpServer?.once('listening', () => {
          const addr = server.httpServer!.address()
          const host =
            typeof addr === 'object' && addr ? `localhost:${addr.port}` : 'localhost:5173'
          setTimeout(() => console.log(`\n  mppx ${host}/api/photo\n`), 100)
        })
      },
    },
  ],
})
