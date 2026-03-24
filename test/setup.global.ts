import { nodeEnv } from './config.js'
import { createServer, port } from './tempo/prool.js'

const defaultStartAttempts = 5
const defaultStartRetryDelayMs = 3_000
const defaultStartRequestTimeoutMs = 120_000

function parsePositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function warmTempoServer() {
  const maxAttempts = parsePositiveInt(process.env.MPPX_TEMPO_START_ATTEMPTS, defaultStartAttempts)
  const requestTimeoutMs = parsePositiveInt(
    process.env.MPPX_TEMPO_START_REQUEST_TIMEOUT_MS,
    defaultStartRequestTimeoutMs,
  )
  const retryDelayMs = parsePositiveInt(
    process.env.MPPX_TEMPO_START_RETRY_DELAY_MS,
    defaultStartRetryDelayMs,
  )

  const startUrl = `http://localhost:${port}/1/start`
  const stopUrl = `http://localhost:${port}/1/stop`

  let lastErrorMessage = 'unknown error'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Starting Tempo server (attempt ${attempt}/${maxAttempts})`)
      const response = await fetch(startUrl, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      if (response.ok) return

      const body = await response.text().catch(() => '(failed to read response body)')
      lastErrorMessage = `HTTP ${response.status} from /1/start: ${body}`
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error)
    }

    await fetch(stopUrl).catch(() => {})
    if (attempt < maxAttempts) await sleep(retryDelayMs)
  }

  throw new Error(
    `Tempo server failed to start after ${maxAttempts} attempts. Last error: ${lastErrorMessage}`,
  )
}

export default async function () {
  if (nodeEnv !== 'localnet') return
  if (process.env.VITE_RPC_URL) return

  const server = await createServer()

  await server.start()

  // Trigger server startup explicitly so image pulls happen during setup,
  // not in the first test that needs the localnet.
  await warmTempoServer()
  console.log('Tempo server started')

  return () => server.stop()
}
