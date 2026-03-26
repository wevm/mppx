import { privateKeyToAccount } from 'viem/accounts'
import type { Account } from 'viem'

/**
 * Create a viem Account from an OWS wallet.
 *
 * Decrypts the EVM signing key from the OWS vault and wraps it
 * as a viem LocalAccount for use with `tempo()`.
 *
 * @example
 * ```ts
 * import { owsAccount } from 'mppx/ows'
 * import { tempo } from 'mppx/tempo'
 *
 * const account = owsAccount('my-wallet')
 * const [charge] = tempo({ account })
 * ```
 */
export function owsAccount(walletNameOrId: string, vaultPath?: string): Account {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { exportWallet } = require('@open-wallet-standard/core') as {
    exportWallet: (nameOrId: string, passphrase?: string, vaultPath?: string) => string
  }

  const exported = exportWallet(walletNameOrId, undefined, vaultPath)

  let privateKey: `0x${string}`

  try {
    const keys = JSON.parse(exported)
    const hex = keys.secp256k1 ?? ''
    privateKey = (hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`
  } catch {
    // Mnemonic — use deriveAddress to get the key
    const { deriveAddress } = require('@open-wallet-standard/core') as {
      deriveAddress: (mnemonic: string, chain: string) => { address: string; private_key?: string; privateKey?: string }
    }
    const info = deriveAddress(exported, 'evm')
    const hex = info.private_key ?? info.privateKey ?? ''
    privateKey = (hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`
  }

  return privateKeyToAccount(privateKey)
}
