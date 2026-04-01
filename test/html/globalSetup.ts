import { execSync } from 'node:child_process'

export default async function globalSetup() {
  execSync(`TEST=1 pnpm build`, {
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
