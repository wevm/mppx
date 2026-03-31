import net from 'node:net'

import { defineConfig } from '@playwright/test'

const project = process.argv.find((_, i, a) => a[i - 1] === '--project')

const chargePort = await getPort('_MPPX_CHARGE_PORT')
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
      name: 'charge',
      testMatch: 'charge.test.ts',
      use: { baseURL: `http://localhost:${chargePort}` },
    },
    {
      name: 'stripe',
      testMatch: 'stripe.test.ts',
      use: { baseURL: `http://localhost:${stripePort}` },
    },
  ],
  webServer: [
    ...(!project || project === 'charge'
      ? [
          {
            command: `pnpm --filter charge dev -- --port ${chargePort}`,
            port: chargePort,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]
      : []),
    ...(!project || project === 'stripe'
      ? [
          {
            command: `pnpm --filter stripe dev -- --port ${stripePort}`,
            port: stripePort,
            reuseExistingServer: !process.env.CI,
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
