import type { Account } from 'viem'
import { createClient } from 'viem'
import { Actions, Addresses } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { accounts, asset, chain, fundAccount, http } from '~test/tempo/viem.js'

import { resolveFeeToken } from './fee-token.js'

const isLocalnet = nodeEnv === 'localnet'

function clientFor(account: Account) {
  return createClient({
    account,
    chain,
    transport: http(),
  })
}

function expectAddress(actual: string | undefined, expected: string) {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase())
}

describe.runIf(isLocalnet)('resolveFeeToken', () => {
  test('uses the funded account fee preference first', async () => {
    const account = accounts[11]
    const client = clientFor(account)
    await fundAccount({ address: account.address, token: asset })
    await Actions.fee.setUserTokenSync(client, {
      feeToken: asset,
      token: asset,
    } as never)

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [Addresses.pathUsd],
      client,
    })

    expectAddress(feeToken, asset)
  })

  test('falls through to the first funded candidate token', async () => {
    const account = accounts[12]
    const client = clientFor(account)
    await fundAccount({ address: account.address, token: asset })

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [Addresses.pathUsd, asset],
      client,
    })

    expectAddress(feeToken, asset)
  })

  test('falls through from an unfunded account fee preference', async () => {
    const account = accounts[13]
    const client = clientFor(account)
    await fundAccount({ address: account.address, token: asset })
    await Actions.fee.setUserTokenSync(client, {
      feeToken: asset,
      token: Addresses.pathUsd,
    } as never)

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [asset],
      client,
    })

    expectAddress(feeToken, asset)
  })

  test('uses a funded chain fee token when configured', async () => {
    const account = accounts[14]
    const client = createClient({
      account,
      chain: { ...chain, feeToken: asset },
      transport: http(),
    })
    await fundAccount({ address: account.address, token: asset })

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [Addresses.pathUsd],
      client,
    })

    expectAddress(feeToken, asset)
  })

  test('falls through from an unfunded chain fee token', async () => {
    const account = accounts[15]
    const client = createClient({
      account,
      chain: { ...chain, feeToken: Addresses.pathUsd },
      transport: http(),
    })
    await fundAccount({ address: account.address, token: asset })

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [asset],
      client,
    })

    expectAddress(feeToken, asset)
  })

  test('falls back to the first known token when none are funded', async () => {
    const account = accounts[16]
    const client = clientFor(account)

    const feeToken = await resolveFeeToken({
      account: account.address,
      candidateTokens: [asset, Addresses.pathUsd],
      client,
    })

    expectAddress(feeToken, asset)
  })
})
