import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'

import { mppxSourceAlias } from '../../_shared/mppxSource.js'
import { handler } from './src/server.ts'

export default defineConfig({
  resolve: {
    alias: mppxSourceAlias,
  },
  plugins: [
    {
      name: 'api',
      configureServer(server) {
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
          const pm = process.env.npm_config_user_agent?.split('/')[0] ?? 'npx'
          setTimeout(
            () => console.log(`\n  ${pm === 'npm' ? 'npx' : pm} mppx http://${host}/api/scrape\n`),
            100,
          )
        })
      },
    },
  ],
})
