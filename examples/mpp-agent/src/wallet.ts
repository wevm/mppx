import { Mppx, tempo } from 'mppx/client'
import { createPublicClient, erc20Abi, http, isAddressEqual, zeroAddress, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'

import { accessKeyAccount, activate, keyState, type KeyState } from './activate.ts'
import { config } from './config.ts'
import {
  describeAccessKey,
  describeLegacy,
  readAccessKey,
  readKey,
  type AccessKeyRecord,
} from './keystore.ts'
import { blockedHost } from './policy.ts'

if (config.proxy) {
  // route ALL outbound fetch traffic (incl. viem RPC) through the egress proxy
  const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici')
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

const transport = http(config.chain.rpcUrls.default.http[0], {
  fetchOptions: { headers: { 'user-agent': 'mpp-agent/1.0' } },
})
export const chain = createPublicClient({ chain: config.chain, transport })

/**
 * Two ways to pay (see config.keySource):
 * - tempo-wallet: an access key the user's Tempo Wallet authorized. Payments come from their wallet, capped by the
 *   key's spending limit and expiry, which the chain enforces. The first payment carries the wallet's signed authorization.
 * - legacy: a local demo wallet whose key this app generated (`pnpm run setup` before Tempo Wallet support).
 */
export type Mode = 'tempo-wallet' | 'legacy'
const SETUP = 'Run `pnpm run setup` to approve this agent in your Tempo Wallet.'

async function load() {
  const forced = config.keySource !== 'auto'
  let note: string | undefined
  if (config.keySource === 'auto' || config.keySource === 'tempo-wallet') {
    const r = readAccessKey()
    // unknown if the chain can't be read: build it pending (viem re-checks before attaching the authorization)
    const state: KeyState | 'unknown' =
      r && r.chainId === config.chain.id
        ? await keyState(chain, r).catch(() => 'unknown' as const)
        : 'unknown'
    const problem = !r
      ? null
      : r.chainId !== config.chain.id
        ? `is for chain ${r.chainId}, not ${config.network}`
        : r.expiry <= Date.now() / 1000
          ? `expired on ${new Date(r.expiry * 1000).toISOString().slice(0, 10)}`
          : state === 'revoked'
            ? 'was revoked'
            : null
    if (r && !problem) {
      const account = await accessKeyAccount(r, { pending: state !== 'active' })
      if (!isAddressEqual(account.accessKeyAddress, r.accessKey))
        throw new Error(`stored access key in ${describeAccessKey()} does not match its address`)
      return { mode: 'tempo-wallet' as const, account, record: r, state }
    }
    if (problem)
      note = `Your Tempo Wallet access key ${problem}. Run \`pnpm run setup -- --reauthorize\` to approve a new one.`
    if (forced)
      throw new SetupNeeded(
        note ?? `No Tempo Wallet access key in ${describeAccessKey()}. ${SETUP}`,
      )
  }
  const key = readKey()
  if (key) return { mode: 'legacy' as const, account: privateKeyToAccount(key), record: null, note }
  throw new SetupNeeded(
    note ??
      (forced
        ? `No key in ${describeLegacy()}. Run \`pnpm run setup\`.`
        : `No wallet yet. ${SETUP}`),
  )
}

export class SetupNeeded extends Error {}
const loaded = await load().catch((e) => {
  if (!(e instanceof SetupNeeded)) throw e
  console.error(`\n✗ ${e.message}\n`)
  process.exit(1)
})
export const { mode } = loaded
export let account = loaded.account
export const accessKey: AccessKeyRecord | null = loaded.record
/** On-chain state of the access key when the server started (tempo-wallet mode). */
export const initialKeyState: KeyState | 'unknown' | null =
  'state' in loaded ? (loaded.state ?? null) : null
/** Shown at startup: e.g. why auto mode fell back to the local demo wallet. */
export const walletNote: string | undefined = 'note' in loaded ? loaded.note : undefined
/** The address that pays (the Tempo Wallet in tempo-wallet mode) and the key that signs. */
export const walletAddress: Address = account.address
export const keyAddress: Address =
  'accessKeyAddress' in account ? account.accessKeyAddress : account.address

export class BlockedError extends Error {}
/** Every request mppx sends (probe, redirects, paid retry) goes through the host blocklist. */
async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  const reason = await blockedHost(url.hostname)
  if (reason) throw new BlockedError(reason)
  return fetch(input, init)
}

const makeMppx = () =>
  Mppx.create({
    polyfill: false, // leave globalThis.fetch alone
    fetch: guardedFetch,
    methods: [tempo({ account, expectedChainId: config.chain.id, getClient: () => chain })],
    // prefer the challenge in our configured token when a server offers several
    orderChallenges: (cs) =>
      [...cs].sort((a, b) => Number(isOurs(b.challenge)) - Number(isOurs(a.challenge))),
  })
export let mppx = makeMppx()

let activating: Promise<void> | null = initialKeyState === 'active' ? Promise.resolve() : null
/**
 * Tempo Wallet mode: make sure the access key is registered on chain before a payment, since fee-sponsored payments
 * refuse a key authorization. Idempotent; a failed attempt is retried on the next call. No-op in legacy mode.
 */
export function ensureActive(): Promise<void> {
  const r = accessKey
  if (!r) return Promise.resolve()
  activating ??= (async () => {
    const state = await keyState(chain, r)
    if (state === 'revoked')
      throw new Error(
        "this agent's access key was revoked in your Tempo Wallet. Run `pnpm run setup -- --reauthorize`.",
      )
    if (state === 'pending') {
      console.log(
        `Registering this agent's access key ${r.accessKey} on chain (one-time transaction from your Tempo Wallet)…`,
      )
      const tx = await activate(r)
      console.log(`✓ Access key registered, fee $${tx.feeUsd.toFixed(4)}: ${tx.url}`)
    }
    account = await accessKeyAccount(r, { pending: false }) // payments no longer carry the authorization
    mppx = makeMppx()
  })().catch((e) => {
    activating = null
    throw e
  })
  return activating
}
const isOurs = (c: { request: Record<string, unknown> }) =>
  String(c.request.currency).toLowerCase() === config.token

export async function balanceUsd(address: Address = walletAddress): Promise<number> {
  const raw = await chain.readContract({
    address: config.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  })
  return Number(raw) / 1e6
}

export type Allowance = {
  remainingUsd: number
  limitUsd: number
  expiresAt: string
  onChain: boolean
  revoked: boolean
}
/**
 * What the access key may still spend. Before its first payment the key isn't on chain yet, so the
 * remaining amount is the limit the wallet approved. Null in legacy mode, or if the chain can't be read.
 */
export async function allowance(): Promise<Allowance | null> {
  const r = accessKey
  if (!r) return null
  const limitRaw = BigInt(r.limit.raw)
  const meta = await Actions.accessKey
    .getMetadata(chain, { account: r.wallet, accessKey: r.accessKey })
    .catch(() => null)
  if (!meta) return null
  const onChain =
    !isAddressEqual(meta.address, zeroAddress) && isAddressEqual(meta.address, r.accessKey)
  let remaining = limitRaw
  if (meta.isRevoked) remaining = 0n
  else if (onChain && meta.spendPolicy === 'limited') {
    const got = await Actions.accessKey
      .getRemainingLimit(chain, { account: r.wallet, accessKey: r.accessKey, token: r.limit.token })
      .catch(() => null)
    if (!got) return null
    remaining = got.remaining
  }
  return {
    remainingUsd: Number(remaining) / 1e6,
    limitUsd: Number(limitRaw) / 1e6,
    expiresAt: new Date(r.expiry * 1000).toISOString(),
    onChain,
    revoked: meta.isRevoked,
  }
}

/** The balance (and, in tempo-wallet mode, the allowance) for `wallet.balance` events and /api/wallet. */
export async function walletSnapshot() {
  const [balance, a] = await Promise.all([
    balanceUsd().catch(() => NaN),
    allowance().catch(() => null),
  ])
  return {
    balanceUsd: balance,
    ...(a
      ? {
          allowanceUsd: a.remainingUsd,
          allowanceLimitUsd: a.limitUsd,
          allowanceExpiresAt: a.expiresAt,
        }
      : {}),
  }
}
