import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { radiusMainnet, radiusTestnet } from '../../src/radius/internal/chain.js'
import * as defaults from '../../src/radius/internal/defaults.js'

// ---------------------------------------------------------------------------
// Network selection
// ---------------------------------------------------------------------------

/** 'mainnet' or 'testnet' — defaults to 'testnet'. */
export const network = (import.meta.env.VITE_RADIUS_NETWORK || 'testnet') as
  | 'mainnet'
  | 'testnet'

export const chain = network === 'mainnet' ? radiusMainnet : radiusTestnet
export const chainId = chain.id

/** Block-explorer base URL for the active network. */
export const explorerUrl =
  network === 'mainnet'
    ? 'https://network.radiustech.xyz'
    : 'https://testnet.radiustech.xyz'

/** Returns a clickable explorer link for a transaction hash. */
export function txUrl(hash: string) {
  return `${explorerUrl}/tx/${hash}`
}

/** Returns a clickable explorer link for an address. */
export function addressUrl(address: string) {
  return `${explorerUrl}/address/${address}`
}

// ---------------------------------------------------------------------------
// Token configuration
// ---------------------------------------------------------------------------

/**
 * Settlement token address and decimals.
 *
 * - **Mainnet**: SBC at 0x33ad…14fb (6 decimals)
 * - **Testnet**: RUSD is the native token (18 decimals) — there is no
 *   SBC contract on testnet, so tests targeting testnet must deploy or
 *   designate an ERC-20 token.  For now we fall back to RUSD.
 */
export const token = (() => {
  if (network === 'mainnet') {
    return {
      address: defaults.tokens.sbc as `0x${string}`,
      decimals: 6,
      symbol: 'SBC',
    }
  }
  // Testnet — RUSD is native, no SBC contract.  The tests use a custom
  // env var or skip gracefully.
  return {
    address: (import.meta.env.VITE_RADIUS_TOKEN_ADDRESS ||
      '0x0000000000000000000000000000000000000000') as `0x${string}`,
    decimals: Number(import.meta.env.VITE_RADIUS_TOKEN_DECIMALS || '18'),
    symbol: 'RUSD',
  }
})()

// ---------------------------------------------------------------------------
// Accounts  (Alice = payer, Bob = payee / server)
// ---------------------------------------------------------------------------

const aliceKey = import.meta.env.VITE_RADIUS_ALICE_PRIVATE_KEY as `0x${string}` | undefined
const bobKey = import.meta.env.VITE_RADIUS_BOB_PRIVATE_KEY as `0x${string}` | undefined

/** True when both Alice and Bob private keys are configured. */
export const hasAccounts = Boolean(aliceKey && bobKey)

export const alice = aliceKey ? privateKeyToAccount(aliceKey) : (undefined as never)
export const bob = bobKey ? privateKeyToAccount(bobKey) : (undefined as never)

// ---------------------------------------------------------------------------
// Viem clients
// ---------------------------------------------------------------------------

/** RPC endpoint — explicit override via env var, or auto-resolved from chain ID. */
const rpcEndpoint =
  import.meta.env.VITE_RADIUS_RPC_URL ||
  defaults.rpcUrl[chainId as keyof typeof defaults.rpcUrl]

export function createRadiusClient(account?: typeof alice) {
  return createClient({
    account,
    chain,
    transport: http(rpcEndpoint),
  })
}

/** Shared read-only client (no account). */
export const publicClient = createRadiusClient()

/** Client bound to Alice's account. */
export const aliceClient = hasAccounts ? createRadiusClient(alice) : (undefined as never)

/** Client bound to Bob's account. */
export const bobClient = hasAccounts ? createRadiusClient(bob) : (undefined as never)
