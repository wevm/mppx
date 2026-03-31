import net from 'node:net'

import { defineConfig } from '@playwright/test'

const port = await getPort('_MPPX_HTML_PORT')

export default defineConfig({
  globalSetup: './globalSetup.ts',
  testDir: '.',
  testMatch: '*.test.ts',
  timeout: 60_000,
  retries: 1,
  use: {
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'tempo',
      testMatch: 'tempo.test.ts',
      use: { baseURL: `http://localhost:${port}` },
    },
    {
      name: 'stripe',
      testMatch: 'stripe.test.ts',
      use: { baseURL: `http://localhost:${port}` },
    },
  ],
})

async function getPort(envKey: string): Promise<number> {
  if (process.env[envKey]) return Number(process.env[envKey])
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
  process.env[envKey] = String(port)
  return port
}
