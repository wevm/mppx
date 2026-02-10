import { nodeEnv } from './config.js'
import { createServer, port } from './tempo/prool.js'

export default async function () {
  if (nodeEnv !== 'localnet') return

  const server = await createServer()

  await server.start()

  // Arbitrary request to start server to trigger Docker image download.
  console.log('Starting Tempo server')
  await fetch(`http://localhost:${port}/1/start`)
  console.log('Tempo server started')

  return () => server.stop()
}
