import { execSync } from 'node:child_process'

export default async function globalSetup() {
  const privateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  execSync(`LOCAL_ACCOUNT=${privateKey} pnpm build`, {
    cwd: new URL('../..', import.meta.url).pathname,
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
