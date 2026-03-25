import { parseUnits } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'
import { afterAll, beforeAll } from 'vp/test'

import { nodeEnv } from './config.js'
import { rpcUrl } from './tempo/prool.js'
import { accounts, asset, client, fundAccount } from './tempo/viem.js'

beforeAll(async () => {
  if (nodeEnv !== 'localnet') return

  // Send noop tx to trigger block.
  await sendTransactionSync(client, {})

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
})

afterAll(async () => {
  if (nodeEnv !== 'localnet') return
  await fetch(`${rpcUrl}/stop`)
})
