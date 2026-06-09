import { createClient, http as viem_http, parseUnits } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'

import { tempoNetworkConfig, tempoRpcUrl as rpcUrl } from '../config.js'
import { accounts, asset, chain, client, fundAccount } from './viem.js'

const warmupAttempts = 5
const warmupRetryDelayMs = 1_000
const warmupRequestTimeoutMs = 30_000
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

async function setupDevnetAccounts() {
  for (const account of [accounts[0], accounts[1], accounts[2]]) await fundDevnetAccount(account)
}

async function setupLocalnetAccounts() {
  await warmupLocalnet()

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
}

/** Prepares accounts for whichever Tempo network the test run selected. */
export async function setupTempoNetwork() {
  if (!tempoNetworkConfig.enabled) return
  if (tempoNetworkConfig.isDevnet) {
    await setupDevnetAccounts()
    return
  }

  await setupLocalnetAccounts()
}
