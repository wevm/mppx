import net from 'node:net'

import { defineConfig } from '@playwright/test'

const project = process.argv.find((_, i, a) => a[i - 1] === '--project')

const tempoPort = await getPort('_MPPX_TEMPO_PORT')
const stripePort = await getPort('_MPPX_STRIPE_PORT')

export default defineConfig({
  globalSetup: './globalSetup.ts',
  testDir: '.',
  testMatch: '*.test.ts',
  timeout: 60_000,
  retries: 1,
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'tempo',
      testMatch: 'charge.test.ts',
      use: { baseURL: `http://localhost:${tempoPort}` },
    },
    {
      name: 'stripe',
      testMatch: 'stripe.test.ts',
      use: { baseURL: `http://localhost:${stripePort}` },
    },
  ],
  webServer: [
    ...(!project || project === 'tempo'
      ? [
          {
            command: `pnpm --filter charge dev -- --port ${tempoPort}`,
            port: tempoPort,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
    ...(!project || project === 'stripe'
      ? [
          {
            command: `pnpm --filter stripe dev -- --port ${stripePort}`,
            port: stripePort,
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
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
