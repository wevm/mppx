/**
 * Token-gate utility for mppx.
 *
 * Wraps any `Method.Server` and grants free access to ERC-20/ERC-721 token
 * holders by checking on-chain balance inside the `verify` hook. The payer's
 * address is extracted from `credential.source` (DID format), so no extra
 * client-side signing is required.
 *
 * @example
 * ```ts
 * import { tokenGate } from 'mppx/token-gate'
 * import { base } from 'viem/chains'
 *
 * const gatedCharge = tokenGate(tempoCharge, {
 *   contracts: [{ address: '0xYourNFT', chain: base, type: 'ERC-721' }],
 * })
 *
 * const mppx = Mppx.create({ methods: [gatedCharge], secretKey: '...' })
 * app.get('/premium', mppx.charge({ amount: '$0.01' }), handler)
 * ```
 */

import { createPublicClient, http } from 'viem'
import type { Chain, PublicClient } from 'viem'
import type * as Method from './Method.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An ERC-20 or ERC-721 token contract to check for holder status.
 */
export type TokenContract = {
  /** Contract address on the EVM chain. */
  address: `0x${string}`
  /** viem chain object (e.g. `base`, `mainnet`). */
  chain: Chain
  /** Token standard. */
  type: 'ERC-20' | 'ERC-721'
  /** Minimum balance required. Defaults to `1n`. For ERC-20 this is in the token's smallest unit. */
  minBalance?: bigint | undefined
  /** Specific ERC-721 token ID. When set, uses `ownerOf()` instead of `balanceOf()`. */
  tokenId?: bigint | undefined
}

/**
 * Options for `tokenGate`.
 */
export type TokenGateOptions = {
  /** Token contracts to check. */
  contracts: TokenContract[]
  /**
   * Whether the address must hold at least one contract (`'any'`) or all
   * contracts (`'all'`). Defaults to `'any'`.
   */
  matchMode?: 'any' | 'all' | undefined
  /**
   * How long to cache on-chain ownership results in seconds.
   * Defaults to `300` (5 minutes).
   */
  cacheTtlSeconds?: number | undefined
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

/** balanceOf(address) → uint256 */
const BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** ownerOf(tokenId) → address */
const OWNER_OF_ABI = [
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

interface CacheEntry {
  isHolder: boolean
  expiresAt: number
}

/** In-memory ownership cache, keyed by `address:chainId:contractAddress[:tokenId]`. */
const ownershipCache = new Map<string, CacheEntry>()

/** Per-chain viem public clients, keyed by chainId. */
const publicClientCache = new Map<number, PublicClient>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a DID-PKH string and returns the EVM address, or `null` if the DID
 * is absent, malformed, or not an EIP-155 (EVM) DID.
 *
 * @param source - DID string, e.g. `"did:pkh:eip155:8453:0xABC..."`
 * @returns The `0x`-prefixed address, or `null`.
 */
export function parseDid(source: string): `0x${string}` | null {
  const parts = source.split(':')
  // Expected: ["did", "pkh", "eip155", chainId, address]
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'eip155') return null
  const address = parts[4]
  if (!address || !address.startsWith('0x')) return null
  return address as `0x${string}`
}

/**
 * Returns a cached viem public client for the given chain.
 *
 * @param chain - viem chain object
 * @returns Public client for the chain
 */
function getPublicClient(chain: Chain): PublicClient {
  const existing = publicClientCache.get(chain.id)
  if (existing) return existing
  const client = createPublicClient({ chain, transport: http() })
  publicClientCache.set(chain.id, client)
  return client
}

/**
 * Checks whether a single contract grants holder status to the address.
 *
 * @param address - EVM wallet address to check
 * @param contract - Token contract definition
 * @param cacheTtlMs - Cache TTL in milliseconds
 * @returns True if the address holds the required tokens
 */
async function checkContract(
  address: `0x${string}`,
  contract: TokenContract,
  cacheTtlMs: number,
): Promise<boolean> {
  const tokenIdSuffix = contract.tokenId !== undefined ? `:${contract.tokenId}` : ''
  const cacheKey = `${address.toLowerCase()}:${contract.chain.id}:${contract.address.toLowerCase()}${tokenIdSuffix}`

  const cached = ownershipCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isHolder
  }

  const client = getPublicClient(contract.chain)
  let isHolder: boolean

  if (contract.type === 'ERC-721' && contract.tokenId !== undefined) {
    try {
      const owner = (await client.readContract({
        address: contract.address,
        abi: OWNER_OF_ABI,
        functionName: 'ownerOf',
        args: [contract.tokenId],
      })) as `0x${string}`
      isHolder = owner.toLowerCase() === address.toLowerCase()
    } catch {
      // ownerOf reverts for non-existent tokens
      isHolder = false
    }
  } else {
    const minBalance = contract.minBalance ?? 1n
    const balance = (await client.readContract({
      address: contract.address,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint
    isHolder = balance >= minBalance
  }

  ownershipCache.set(cacheKey, { isHolder, expiresAt: Date.now() + cacheTtlMs })
  return isHolder
}

/**
 * Checks on-chain token ownership for the given address across all contracts.
 *
 * @param address - EVM wallet address
 * @param contracts - Token contracts to check
 * @param matchMode - `'any'` (default) or `'all'`
 * @param cacheTtlMs - Cache TTL in milliseconds
 * @returns True if the address qualifies as a token holder
 */
async function checkOwnership(
  address: `0x${string}`,
  contracts: TokenContract[],
  matchMode: 'any' | 'all',
  cacheTtlMs: number,
): Promise<boolean> {
  if (contracts.length === 0) return false

  if (matchMode === 'all') {
    for (const contract of contracts) {
      if (!(await checkContract(address, contract, cacheTtlMs))) return false
    }
    return true
  }

  for (const contract of contracts) {
    if (await checkContract(address, contract, cacheTtlMs)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps a `Method.Server` and grants free access to token holders.
 *
 * The payer's address is extracted from `credential.source` (a DID-PKH string
 * embedded in the credential). If the address holds the required tokens, a
 * free receipt is returned instead of settling payment. Non-holders and
 * credentials without a `source` field fall through to the original `verify`.
 *
 * On-chain results are cached in-process for 5 minutes by default
 * (configurable via `cacheTtlSeconds`).
 *
 * @param server - The method server to wrap (e.g. a tempo charge server).
 * @param options - Token contracts and cache options.
 * @returns A new `Method.Server` with token-gate logic in `verify`.
 *
 * @example
 * ```ts
 * import { tokenGate } from 'mppx/token-gate'
 * import { base } from 'viem/chains'
 *
 * const gatedCharge = tokenGate(tempoCharge, {
 *   contracts: [{ address: '0xYourNFT', chain: base, type: 'ERC-721' }],
 * })
 * ```
 */
export function tokenGate<
  const method extends Method.Method,
  const defaults extends Method.RequestDefaults<method>,
  const transportOverride,
>(
  server: Method.Server<method, defaults, transportOverride>,
  options: TokenGateOptions,
): Method.Server<method, defaults, transportOverride> {
  const { contracts, matchMode = 'any', cacheTtlSeconds = 300 } = options
  const cacheTtlMs = cacheTtlSeconds * 1000

  return {
    ...server,
    verify: async (params) => {
      const { credential } = params

      // No source field — fall through to normal payment
      if (!credential.source) {
        return server.verify(params)
      }

      // Parse DID to extract EVM address
      const address = parseDid(credential.source)
      if (!address) {
        // Unparseable or non-EVM DID — fall through
        return server.verify(params)
      }

      // Check on-chain ownership (cached)
      const isHolder = await checkOwnership(address, contracts, matchMode, cacheTtlMs)

      if (isHolder) {
        // Token holder — grant free access
        return {
          method: server.name,
          reference: 'token-gate:free',
          status: 'success',
          timestamp: new Date().toISOString(),
        }
      }

      // Not a holder — normal payment
      return server.verify(params)
    },
  }
}

/**
 * Clears the in-memory ownership and public client caches.
 * Useful for testing or when you need to force fresh on-chain lookups.
 */
export function clearTokenGateCache(): void {
  ownershipCache.clear()
  publicClientCache.clear()
}
