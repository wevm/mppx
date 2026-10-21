// Register a Tempo Wallet access key on chain ("activation"). Until a key is registered, every transaction it signs must
// carry the wallet's key authorization, and fee-sponsored MPP payments refuse those ("fee-sponsored transaction
// keyAuthorization is not allowed"). So before the first payment we send one transaction the wallet pays for itself:
// a 0 USDC.e transfer to itself (allowed by the key's transfer-only scope, spends nothing from the limit), signed by the
// access key and carrying the authorization. After that the key is on chain and payments no longer carry it.
import { KeyAuthorization } from 'ox/tempo'
import {
  createWalletClient,
  http,
  isAddressEqual,
  pad,
  zeroAddress,
  type Client,
  type Hex,
} from 'viem'
import { Account as TempoAccount, Actions, KeyAuthorizationManager } from 'viem/tempo'

import { config } from './config.ts'
import type { AccessKeyRecord } from './keystore.ts'

const TRANSFER: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const transport = http(config.chain.rpcUrls.default.http[0], {
  fetchOptions: { headers: { 'user-agent': 'mpp-agent/1.0' } },
})

export type KeyState = 'pending' | 'active' | 'revoked'
/** Reads the AccountKeychain precompile: is this key registered for this wallet (and not revoked)? */
export async function keyState(client: Client, r: AccessKeyRecord): Promise<KeyState> {
  const meta = await Actions.accessKey.getMetadata(client, {
    account: r.wallet,
    accessKey: r.accessKey,
  })
  if (meta.isRevoked) return 'revoked'
  return !isAddressEqual(meta.address, zeroAddress) && isAddressEqual(meta.address, r.accessKey)
    ? 'active'
    : 'pending'
}

/** The signing account. Only a pending key carries the authorization (viem attaches it, and drops it once on chain). */
export async function accessKeyAccount(r: AccessKeyRecord, { pending }: { pending: boolean }) {
  if (!pending) return TempoAccount.fromSecp256k1(r.privateKey, { access: r.wallet })
  const keyAuthorizationManager = KeyAuthorizationManager.memory()
  await keyAuthorizationManager.set(
    { address: r.wallet, accessKey: r.accessKey, chainId: r.chainId },
    KeyAuthorization.fromRpc(r.keyAuthorization as never),
  )
  return TempoAccount.fromSecp256k1(r.privateKey, { access: r.wallet, keyAuthorizationManager })
}

async function activationTx(r: AccessKeyRecord) {
  const account = await accessKeyAccount(r, { pending: true })
  const wallet = createWalletClient({ account, chain: config.chain, transport })
  const call = Actions.token.transfer.call(wallet, {
    token: config.token,
    to: r.wallet,
    amount: 0n,
  })
  return { wallet, call }
}

/** Upper bound on the activation fee, in token base units (gas +20% × maxFeePerGas, in 6-decimal units). */
export async function estimateActivation(r: AccessKeyRecord) {
  const { wallet, call } = await activationTx(r)
  const p = (await wallet.prepareTransactionRequest({
    calls: [call],
    feeToken: config.token,
  } as never)) as { gas?: bigint; maxFeePerGas?: bigint; keyAuthorization?: unknown }
  if (!p.gas || !p.maxFeePerGas) throw new Error('could not estimate the activation fee')
  return {
    maxFee: (((p.gas * 12n) / 10n) * p.maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n,
    carriesAuthorization: !!p.keyAuthorization,
  }
}

/** Sends the activation tx and waits for it. Returns the tx and the fee actually paid (USDC.e that left the wallet). */
export async function activate(r: AccessKeyRecord) {
  const { wallet } = await activationTx(r)
  const { receipt } = await Actions.token.transferSync(wallet, {
    token: config.token,
    to: r.wallet,
    amount: 0n,
    feeToken: config.token,
  } as never)
  if (receipt.status !== 'success')
    throw new Error(`activation reverted (tx ${receipt.transactionHash})`)
  const from = pad(r.wallet).toLowerCase()
  const fee = receipt.logs
    .filter((l) => l.topics[0] === TRANSFER && l.topics[1]?.toLowerCase() === from)
    .reduce((s, l) => s + BigInt(l.data), 0n)
  return {
    hash: receipt.transactionHash,
    url: `${config.explorer}/tx/${receipt.transactionHash}`,
    feeUsd: Number(fee) / 1e6,
  }
}
