import { Base64 } from 'ox'
import {
  createPublicClient,
  getAddress,
  isAddress,
  http,
  toHex,
  verifyMessage,
  type Address,
  type Hex,
} from 'viem'

import type * as Identity from '../../../../identity/Types.js'
import * as Store from '../../../../Store.js'
import { message } from '../client/index.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

const abi = [
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'lookupHuman',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Creates a request-stage identity verifier for World AgentKit: the request must carry an
 * `agentkit` header signed by a wallet that a World ID-verified human registered in AgentBook.
 *
 * It checks the SIWE message's domain, URI host and lifetime, claims its nonce once, verifies the
 * signature, then reads AgentBook on World Chain. The verified value carries the anonymous human
 * identifier, so usage can be limited per human rather than per agent.
 *
 * @example
 * ```ts
 * const human = World.Server.verifier({
 *   nonceStore: Store.redis(redis),
 *   origins: ['https://api.example'],
 *   rpcUrl: process.env.WORLD_CHAIN_RPC_URL,
 * })
 * mppx.charge({ amount: '0.01', identity: [human] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedAgent> {
  const maxAge = config.maxAge ?? Constants.maxAge
  const lookup = cached(agentBook({ rpcUrl: config.rpcUrl, ...config.agentBook }))
  const clients = signingClients(config)
  const origins = config.origins.map((origin) => new URL(origin).origin)
  return {
    async verify(request) {
      const header = request.headers.get(Constants.header)
      if (!header)
        return {
          status: 'missing',
          reason: 'Sign the request with a World ID-backed agent wallet (AgentKit).',
        }
      const payload = parse(header)
      if (!payload) return { status: 'invalid', reason: 'The agentkit header is malformed.' }

      const reason = check(payload, origins, maxAge)
      if (reason) return { status: 'invalid', reason }

      const chainId = Number(payload.chainId.slice('eip155:'.length))
      let text: string
      try {
        text = message(payload)
      } catch {
        return { status: 'invalid', reason: 'The agentkit message is not a valid SIWE message.' }
      }
      const parameters = {
        address: payload.address as Address,
        message: text,
        signature: payload.signature as Hex,
      }
      let valid = false
      // An EOA signature recovers locally, without an RPC call.
      try {
        valid = await verifyMessage(parameters)
      } catch {}
      // Otherwise it may be a smart account's: ERC-1271, or ERC-6492 before deployment. Only
      // payloads that declare one reach the RPC, so a forged EOA signature costs no call.
      const client = !valid && payload.type === 'eip1271' ? clients.get(chainId) : undefined
      if (client)
        try {
          valid = await client.verifyMessage(parameters)
          // viem reports a failed eth_call as an invalid signature: tell an outage apart.
          if (!valid) await client.getChainId?.()
        } catch {
          return {
            status: 'unavailable',
            reason: 'Smart-account signature verification is unavailable.',
          }
        }
      if (!valid) return { status: 'invalid', reason: 'The agentkit signature is invalid.' }

      let humanId: string | undefined
      try {
        humanId = await lookup(payload.address as Address)
      } catch {
        return { status: 'unavailable', reason: 'AgentBook is unavailable.' }
      }
      if (!humanId)
        return {
          status: 'forbidden',
          headers: { Link: `<${Constants.registration}>; rel="register"` },
          reason: `The agent wallet is not registered in AgentBook. Register it with: npx @worldcoin/agentkit-cli register ${payload.address}`,
        }
      // Claim the nonce only for registered wallets, so rejected ones leave no replay state.
      try {
        const expires = Date.parse(payload.issuedAt) + (maxAge + Constants.clockSkew) * 1000
        const key = `world:${payload.address.toLowerCase()}:${payload.nonce}`
        if (!(await Store.tryClaim(config.nonceStore, key, expires)))
          return { status: 'invalid', reason: 'The agentkit nonce has already been used.' }
      } catch {
        return { status: 'unavailable', reason: 'Replay protection is unavailable.' }
      }

      return {
        status: 'valid',
        value: Object.freeze({
          address: getAddress(payload.address),
          chainId: `eip155:${chainId}`,
          humanId,
        }),
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Atomically claims each message nonce, shared across instances. */
    nonceStore: Store.AtomicStore
    /**
     * The server's public origins, such as `['https://api.example']`. The signed domain and URI
     * must match one of them. The request's own URL is never used: its host comes from the
     * `Host` header, so a header signed for another site could be replayed here.
     */
    origins: readonly string[]
    /**
     * Your World Chain RPC URL, for AgentBook lookups and World Chain smart-account signatures.
     * Any request can trigger a lookup, so use a provider you control and rate-limit, not a
     * shared public endpoint.
     */
    rpcUrl: string
    /** Overrides for AgentBook, such as its address or a client for tests. */
    agentBook?: Omit<agentBook.Config, 'rpcUrl'> | undefined
    /**
     * RPC URLs for other signing chains, to verify smart-account (ERC-1271 and ERC-6492)
     * signatures from payloads typed `eip1271`. World Chain uses `rpcUrl`. Add a chain only if
     * its accounts are controlled as on World Chain: the same address can belong to someone else
     * on another chain, and AgentBook does not record which chain registered it. Smart accounts
     * on other chains are rejected.
     */
    rpcUrls?: Record<number, string> | undefined
    /** Clients by signing chain ID, taking precedence over `rpcUrls`, such as for tests. */
    clients?: Record<number, SigningClient> | undefined
    /** Maximum age, in seconds, of a signed message. @default 300 */
    maxAge?: number | undefined
  }
}

/** Verifies a message signature on chain, including ERC-1271 and ERC-6492 smart accounts. */
type SigningClient = {
  verifyMessage: (parameters: {
    address: Address
    message: string
    signature: Hex
  }) => Promise<boolean>
  /** Reaches the RPC, to tell an outage from an invalid signature. */
  getChainId?: (() => Promise<number>) | undefined
}

/** One client per allowed signing chain: never an RPC the request names. */
function signingClients(config: verifier.Config): Map<number, SigningClient> {
  const urls = { [Constants.worldChainId]: config.rpcUrl, ...config.rpcUrls }
  const clients = new Map<number, SigningClient>()
  for (const [id, url] of Object.entries(urls))
    clients.set(
      Number(id),
      createPublicClient({ chain: { id: Number(id) } as never, transport: http(url) }),
    )
  for (const [id, client] of Object.entries(config.clients ?? {})) clients.set(Number(id), client)
  return clients
}

/**
 * Returns a function that resolves an agent wallet to its anonymous human identifier in
 * AgentBook, or `undefined` when the wallet is not registered.
 */
export function agentBook(config: agentBook.Config = {}) {
  const address = config.address ?? Constants.agentBook
  const client =
    config.client ??
    createPublicClient({
      chain: { id: Constants.worldChainId } as never,
      transport: http(config.rpcUrl ?? Constants.rpcUrl),
    })
  return async (agent: Address): Promise<string | undefined> => {
    const humanId = (await client.readContract({
      address,
      abi,
      functionName: 'lookupHuman',
      args: [agent],
    })) as bigint
    return humanId === 0n ? undefined : toHex(humanId)
  }
}

export declare namespace agentBook {
  type Config = {
    /** AgentBook contract address. @default the canonical World Chain deployment */
    address?: Address | undefined
    /** World Chain RPC URL. @default World Chain's public RPC */
    rpcUrl?: string | undefined
    /** A client to read the contract with, such as for tests or a private RPC. */
    client?: { readContract: (parameters: any) => Promise<unknown> } | undefined
  }
}

/** How long, in milliseconds, an AgentBook answer is reused, so floods of requests share calls. */
const lookupTtl = { registered: 60_000, unregistered: 10_000 }

/** The most wallets each cache holds; the oldest entry goes first. */
const lookupLimit = 10_000

/**
 * Caches AgentBook answers briefly and shares in-flight lookups for the same wallet. Registered
 * and unregistered wallets are kept apart, so a flood of fresh wallets never evicts real agents.
 */
function cached(lookup: (agent: Address) => Promise<string | undefined>) {
  type Entry = { expires: number; value: Promise<string | undefined> }
  const registered = new Map<string, Entry>()
  const other = new Map<string, Entry>()
  const put = (entries: Map<string, Entry>, key: string, entry: Entry) => {
    entries.delete(key)
    if (entries.size >= lookupLimit) entries.delete(entries.keys().next().value!)
    entries.set(key, entry)
  }
  return (agent: Address) => {
    const key = agent.toLowerCase()
    const now = Date.now()
    const fresh = (entry: Entry | undefined) => (entry && entry.expires > now ? entry : undefined)
    const entry = fresh(registered.get(key)) ?? fresh(other.get(key))
    if (entry) return entry.value
    registered.delete(key)
    const value = lookup(agent)
    put(other, key, { expires: Number.POSITIVE_INFINITY, value })
    value.then(
      (humanId) => {
        other.delete(key)
        if (humanId) put(registered, key, { expires: Date.now() + lookupTtl.registered, value })
        else put(other, key, { expires: Date.now() + lookupTtl.unregistered, value })
      },
      () => other.delete(key),
    )
    return value
  }
}

function parse(header: string): Types.Payload | undefined {
  try {
    const value = JSON.parse(Base64.toString(header)) as Record<string, unknown>
    const strings = [
      'domain',
      'address',
      'uri',
      'version',
      'chainId',
      'nonce',
      'issuedAt',
      'signature',
    ]
    if (!value || strings.some((name) => typeof value[name] !== 'string')) return undefined
    const optional = ['statement', 'expirationTime', 'notBefore', 'requestId']
    if (optional.some((name) => value[name] !== undefined && typeof value[name] !== 'string'))
      return undefined
    if (
      value.resources !== undefined &&
      !(Array.isArray(value.resources) && value.resources.every((r) => typeof r === 'string'))
    )
      return undefined
    if (value.type !== 'eip191' && value.type !== 'eip1271') return undefined
    if (value.version !== '1') return undefined
    // A canonical, positive chain ID, so the signed `Chain ID` line and the result agree.
    if (!/^eip155:[1-9]\d{0,15}$/.test(value.chainId as string)) return undefined
    if (!Number.isSafeInteger(Number((value.chainId as string).slice('eip155:'.length))))
      return undefined
    // SIWE request IDs are pchar: no spaces or line breaks that could restate signed lines.
    if (value.requestId !== undefined && !/^[\x21-\x7e]*$/.test(value.requestId as string))
      return undefined
    // Lowercase or EIP-55 checksummed, normalised so one signature has one spelling.
    if (!isAddress(value.address as string, { strict: true })) return undefined
    value.address = getAddress(value.address as string)
    return value as Types.Payload
  } catch {
    return undefined
  }
}

/** Returns why a message does not fit the request, or `undefined` when it does. */
function check(
  payload: Types.Payload,
  origins: readonly string[],
  maxAge: number,
): string | undefined {
  let uri: URL
  try {
    uri = new URL(payload.uri)
  } catch {
    return 'The agentkit message URI is invalid.'
  }
  if (!origins.includes(uri.origin)) return 'The agentkit message is for another URI.'
  if (payload.domain !== uri.hostname) return 'The agentkit message is for another domain.'
  const now = Date.now()
  const issuedAt = Date.parse(payload.issuedAt)
  if (Number.isNaN(issuedAt)) return 'The agentkit message has no valid issuedAt.'
  if (issuedAt > now + Constants.clockSkew * 1000)
    return 'The agentkit message is issued in the future.'
  if (now - issuedAt > maxAge * 1000) return 'The agentkit message is too old.'
  if (payload.expirationTime && !(Date.parse(payload.expirationTime) > now))
    return 'The agentkit message has expired.'
  if (payload.notBefore && !(Date.parse(payload.notBefore) <= now))
    return 'The agentkit message is not valid yet.'
  return undefined
}
