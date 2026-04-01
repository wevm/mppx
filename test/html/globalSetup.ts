import { execSync } from 'node:child_process'

import type { FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig) {
  const stripeProject = config.projects.find((project) => project.name === 'stripe')
  const stripeMode = stripeProject?.use.headless === false ? 'production' : 'test'

  execSync(`pnpm build`, {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      STRIPE_HTML_MODE: stripeMode,
      TEST: '1',
    },
    stdio: 'inherit',
  })

  const port = Number(process.env._MPPX_HTML_PORT)
  if (!port) throw new Error('Missing _MPPX_HTML_PORT')

  const { startServer } = await import('./server.js')
  const server = await startServer(port)

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
