import { createClient, http as viem_http, parseUnits } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'
import { afterAll, beforeAll } from 'vp/test'

import { nodeEnv } from './config.js'
import { rpcUrl } from './tempo/prool.js'
import { accounts, asset, chain, client, fundAccount } from './tempo/viem.js'

const stopTimeoutMs = 2_000
const setupTimeoutMs = 120_000
const warmupAttempts = 5
const warmupRetryDelayMs = 1_000
const warmupRequestTimeoutMs = 10_000

const warmupClient = createClient({
  account: accounts[0],
  chain,
  transport: viem_http(rpcUrl, {
    retryCount: 0,
    timeout: warmupRequestTimeoutMs,
  }),
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function warmupLocalnet() {
  let lastError: unknown

  for (let attempt = 1; attempt <= warmupAttempts; attempt++) {
    try {
      await sendTransactionSync(warmupClient, {})
      return
    } catch (error) {
      lastError = error
      if (attempt === warmupAttempts) break
      await sleep(warmupRetryDelayMs)
    }
  }

  throw lastError
}

beforeAll(async () => {
  if (nodeEnv !== 'localnet') return

  // Send noop tx to trigger block.
  await warmupLocalnet()

  // Mint liquidity for fee tokens.
  await Promise.all(
    [1n, 2n, 3n].map((id) =>
      Actions.amm.mintSync(client, {
        account: accounts[0],
        feeToken: Addresses.pathUsd,
        nonceKey: 'expiring',
        userTokenAddress: id,
        validatorTokenAddress: Addresses.pathUsd,
        validatorTokenAmount: parseUnits('1000', 6),
        to: accounts[0].address,
      }),
    ),
  )

  await fundAccount({ address: accounts[1].address, token: asset })
  await fundAccount({ address: accounts[2].address, token: asset })
}, setupTimeoutMs)

afterAll(async () => {
  if (nodeEnv !== 'localnet') return

  // Teardown is best-effort: when the localnet instance is already unhealthy,
  // waiting forever here can keep the whole Vitest worker alive.
  await fetch(`${rpcUrl}/stop`, { signal: AbortSignal.timeout(stopTimeoutMs) }).catch(() => {})
})
