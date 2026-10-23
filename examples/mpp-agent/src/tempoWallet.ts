import { spawn } from 'node:child_process'

// Ask the user's Tempo Wallet to authorize an access key for this agent (used by `pnpm run setup` only).
// We generate the key here and send the wallet only its public key; the wallet signs an authorization capping what the
// key may spend (USDC.e limit), until when (expiry), and what it may call (USDC.e transfers). The user approves with
// their passkey on wallet.tempo.xyz via a device code. Nothing is stored in the tempo CLI's own ~/.tempo store.
import { Storage } from 'accounts'
import { Provider } from 'accounts/cli'
import { KeyAuthorization } from 'ox/tempo'
import { isAddressEqual, toHex, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { config } from './config.ts'
import type { AccessKeyRecord } from './keystore.ts'

const openBrowser = (url: string) => {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : (['xdg-open', [url]] as const)
  spawn(cmd, args, { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref()
}

export async function authorizeAccessKey(opts: {
  limitUsd: number
  days: number
  browser: boolean
}): Promise<AccessKeyRecord> {
  const privateKey = generatePrivateKey()
  const key = privateKeyToAccount(privateKey)
  const expiry = Math.floor(Date.now() / 1000) + Math.round(opts.days * 86_400)
  const limitRaw = BigInt(Math.round(opts.limitUsd * 1e6))
  const provider = Provider.create({
    name: 'mpp-agent',
    storage: Storage.memory(), // the SDK's state is throwaway; we keep only the record returned below
    testnet: config.network === 'testnet',
    open(url, prompt) {
      console.log(`\n  Approve in your Tempo Wallet: ${url}`)
      console.log(`  Confirmation code: ${prompt.userCode.replace(/^(.{4})(.{4})$/, '$1-$2')}`)
      console.log(`  (waiting up to 5 minutes; Ctrl-C to cancel)`)
      if (opts.browser) openBrowser(url)
    },
  })
  await provider.ready()
  const result = (await provider.request({
    method: 'wallet_connect',
    params: [
      {
        chainId: toHex(config.chain.id),
        capabilities: {
          authorizeAccessKey: {
            expiry,
            keyType: 'secp256k1',
            publicKey: key.publicKey,
            limits: [{ token: config.token, limit: toHex(limitRaw) }],
            scopes: [
              { address: config.token, selector: 'transfer(address,uint256)' },
              { address: config.token, selector: 'transferWithMemo(address,uint256,bytes32)' },
            ],
          },
        },
      },
    ],
  } as never)) as {
    accounts: { address: Address; capabilities?: { keyAuthorization?: Record<string, unknown> } }[]
  }

  const wallet = result.accounts?.[0]
  const rpc = wallet?.capabilities?.keyAuthorization
  if (!wallet || !rpc)
    throw new Error('the wallet approved the connection but returned no access-key authorization')
  // Trust what the wallet signed, not what we asked for: the user may have changed the limit or expiry.
  const signed = KeyAuthorization.fromRpc(rpc as never)
  if (!isAddressEqual(signed.address, key.address))
    throw new Error('the wallet authorized a different key than the one this agent generated')
  if (Number(signed.chainId) !== config.chain.id)
    throw new Error(`the wallet authorized chain ${signed.chainId}, not ${config.chain.id}`)
  const limit = signed.limits?.find((l) => isAddressEqual(l.token, config.token))
  // No limits at all would mean unlimited spending: refuse to keep such a key (the user can revoke it in the wallet).
  if (!limit?.limit)
    throw new Error(
      `the wallet authorized key ${key.address} without a ${config.symbol} spending limit, so it was not saved. ` +
        'Revoke it in your Tempo Wallet (or `tempo wallet revoke ' +
        key.address +
        '`) and run setup again.',
    )
  const { address: _a, ...keyAuthorization } = rpc // `address` is an SDK convenience alias of keyId
  return {
    version: 1,
    chainId: config.chain.id,
    wallet: wallet.address,
    accessKey: key.address,
    privateKey,
    keyAuthorization,
    expiry: signed.expiry ? Number(signed.expiry) : expiry,
    limit: { token: config.token, raw: String(limit.limit) },
    createdAt: new Date().toISOString(),
  }
}
