import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)

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
          server.httpServer?.once('listening', () => {
            const addr = server.httpServer!.address()
            const host =
              typeof addr === 'object' && addr ? `localhost:${addr.port}` : 'localhost:5173'
            setTimeout(() => console.log(`\n  mppx ${host}/api/fortune\n`), 100)
          })
        },
      },
    ],
  }
})
