import * as node_crypto from 'node:crypto'
import * as node_fs from 'node:fs/promises'
import * as node_os from 'node:os'
import * as node_path from 'node:path'

import { createClient, http as viem_http, parseUnits } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'
import { afterAll, beforeAll } from 'vp/test'

import { nodeEnv } from './config.js'
import { rpcUrl } from './tempo/prool.js'
import { accounts, asset, chain, client, fundAccount } from './tempo/viem.js'

const setupTimeoutMs = 120_000
const setupLockStaleAfterMs = 2 * setupTimeoutMs
const warmupAttempts = 5
const warmupRetryDelayMs = 1_000
const warmupRequestTimeoutMs = 10_000
const devnetFaucetAttempts = 3
const devnetFaucetRetryDelayMs = 3_000
const devnetFaucetRequestTimeoutMs = 30_000

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

const localnetSetupKey = node_crypto.createHash('sha256').update(rpcUrl).digest('hex').slice(0, 16)
const localnetSetupDir = node_path.join(node_os.tmpdir(), `mppx-localnet-setup-${localnetSetupKey}`)
const localnetSetupDone = node_path.join(localnetSetupDir, 'done')
const localnetSetupLock = node_path.join(localnetSetupDir, 'lock')
const devnetSetupKey = node_crypto.createHash('sha256').update(rpcUrl).digest('hex').slice(0, 16)
const devnetSetupDir = node_path.join(node_os.tmpdir(), `mppx-devnet-setup-${devnetSetupKey}`)
const devnetSetupLock = node_path.join(devnetSetupDir, 'lock')

type SetupLockMetadata = {
  createdAt: number
  pid: number
  rpcUrl: string
}

async function exists(path: string) {
  try {
    await node_fs.access(path)
    return true
  } catch {
    return false
  }
}

async function writeSetupLockMetadata(path: string) {
  const metadata = {
    createdAt: Date.now(),
    pid: process.pid,
    rpcUrl,
  } satisfies SetupLockMetadata
  await node_fs.writeFile(node_path.join(path, 'metadata.json'), JSON.stringify(metadata))
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isStaleSetupLock(path: string): Promise<boolean> {
  try {
    const raw = await node_fs.readFile(node_path.join(path, 'metadata.json'), 'utf8')
    const metadata = JSON.parse(raw) as Partial<SetupLockMetadata>
    if (typeof metadata.createdAt !== 'number') return true
    if (Date.now() - metadata.createdAt > setupLockStaleAfterMs) return true
    if (typeof metadata.pid !== 'number') return true
    return !isProcessAlive(metadata.pid)
  } catch {
    return true
  }
}

async function acquireSetupLock(path: string, done?: string | undefined) {
  for (;;) {
    try {
      await node_fs.mkdir(path)
      await writeSetupLockMetadata(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (done && (await exists(done))) return
      if (await isStaleSetupLock(path)) {
        await node_fs.rm(path, { recursive: true, force: true })
        continue
      }
      await sleep(250)
    }
  }
}

async function runLocalnetSetupLocked(fn: () => Promise<void>) {
  await node_fs.mkdir(localnetSetupDir, { recursive: true })
  if (await exists(localnetSetupDone)) return

  await acquireSetupLock(localnetSetupLock, localnetSetupDone)
  if (await exists(localnetSetupDone)) return

  try {
    if (await exists(localnetSetupDone)) return
    await fn()
    await node_fs.writeFile(localnetSetupDone, new Date().toISOString())
  } finally {
    await node_fs.rm(localnetSetupLock, { recursive: true, force: true })
  }
}

async function runDevnetSetupLocked(fn: () => Promise<void>) {
  await node_fs.mkdir(devnetSetupDir, { recursive: true })
  await acquireSetupLock(devnetSetupLock)

  try {
    await fn()
  } finally {
    await node_fs.rm(devnetSetupLock, { recursive: true, force: true })
  }
}

type LocalnetSetupState = {
  done: boolean
  promise: Promise<void> | undefined
}

type DevnetSetupState = {
  done: boolean
  promise: Promise<void> | undefined
}

const localnetSetupState = (() => {
  const globalState = globalThis as typeof globalThis & {
    __mppxLocalnetSetup__?: LocalnetSetupState
  }
  return (globalState.__mppxLocalnetSetup__ ??= {
    done: false,
    promise: undefined,
  })
})()

const devnetSetupState = (() => {
  const globalState = globalThis as typeof globalThis & {
    __mppxDevnetSetup__?: DevnetSetupState
  }
  return (globalState.__mppxDevnetSetup__ ??= {
    done: false,
    promise: undefined,
  })
})()

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

async function fundDevnetAccount(account: (typeof accounts)[number]) {
  let lastError: unknown

  for (let attempt = 1; attempt <= devnetFaucetAttempts; attempt++) {
    try {
      await Actions.faucet.fundSync(client, {
        account,
        timeout: devnetFaucetRequestTimeoutMs,
      })
      return
    } catch (error) {
      lastError = error
      if (attempt === devnetFaucetAttempts) break
      await sleep(devnetFaucetRetryDelayMs)
    }
  }

  throw lastError
}

beforeAll(async () => {
  if (nodeEnv !== 'localnet' && nodeEnv !== 'devnet') return

  if (nodeEnv === 'devnet') {
    if (devnetSetupState.done) return
    if (devnetSetupState.promise) {
      await devnetSetupState.promise
      return
    }

    devnetSetupState.promise = runDevnetSetupLocked(async () => {
      // Fund deterministic test accounts used by the precompile/session suites.
      // The devnet faucet funds the chain's configured test TIP-20 tokens.
      for (const account of [accounts[0], accounts[1], accounts[2]])
        await fundDevnetAccount(account)
      devnetSetupState.done = true
    })

    try {
      await devnetSetupState.promise
    } catch (error) {
      devnetSetupState.promise = undefined
      throw error
    }
    return
  }

  if (localnetSetupState.done) return
  if (localnetSetupState.promise) {
    await localnetSetupState.promise
    return
  }

  localnetSetupState.promise = runLocalnetSetupLocked(async () => {
    // Send noop tx to trigger block.
    await warmupLocalnet()

    // Mint liquidity for fee tokens. Keep setup transactions sequential so
    // externally managed localnet/devnet/testnet/mainnet RPCs cannot race nonce
    // assignment for the shared funding account.
    for (const id of [1n, 2n, 3n]) {
      await Actions.amm.mintSync(client, {
        account: accounts[0],
        feeToken: Addresses.pathUsd,
        nonceKey: 'expiring',
        userTokenAddress: id,
        validatorTokenAddress: Addresses.pathUsd,
        validatorTokenAmount: parseUnits('1000', 6),
        to: accounts[0].address,
      })
    }

    await fundAccount({ address: accounts[1].address, token: asset })
    await fundAccount({ address: accounts[2].address, token: asset })
    await fundAccount({ address: accounts[1].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    localnetSetupState.done = true
  })

  try {
    await localnetSetupState.promise
  } catch (error) {
    localnetSetupState.promise = undefined
    throw error
  }
}, setupTimeoutMs)

afterAll(async () => {
  if (nodeEnv !== 'localnet') return

  // The localnet instance is shared across many setup-file executions in a worker.
  // Global test teardown stops the backing server, so avoid per-file /stop calls
  // that can race with subsequent files and force repeated bootstrap transactions.
})
