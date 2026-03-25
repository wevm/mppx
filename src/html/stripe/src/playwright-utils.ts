import * as path from 'node:path'

import { test as base } from '@playwright/test'
import { createServer } from 'vite'

export const test = base.extend<object, { baseUrl: string }>({
  baseUrl: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await createServer({
        root: path.resolve(import.meta.dirname, '..'),
        configFile: path.resolve(import.meta.dirname, '..', 'vite.config.ts'),
        server: { port: 25678 + Math.floor(Math.random() * 1000), strictPort: false },
      })
      await server.listen()
      process.on('exit', server.close)
      const address = server.httpServer?.address()
      const port = typeof address === 'object' && address ? address.port : 5173
      await use(`http://localhost:${port}`)
      process.off('exit', server.close)
      await server.close()
    },
    { scope: 'worker' },
  ],
})
