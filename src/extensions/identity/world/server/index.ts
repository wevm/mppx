import { Base64 } from 'ox'
import { createPublicClient, http, toHex, verifyMessage, type Address, type Hex } from 'viem'
import { worldchain } from 'viem/chains'

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
 * const human = World.Server.verifier({ nonceStore: Store.memory() })
 * mppx.charge({ amount: '0.01', identity: [human] })
 * ```
 */
export function verifier(config: verifier.Config): Identity.Verifier<Types.VerifiedAgent> {
  const maxAge = config.maxAge ?? Constants.maxAge
  const lookup = agentBook(config.agentBook)
  const clients = signingClients(config)
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

      const url = new URL(request.url)
      const reason = check(payload, url, maxAge)
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
        } catch {
          return {
            status: 'unavailable',
            reason: 'Smart-account signature verification is unavailable.',
          }
        }
      if (!valid) return { status: 'invalid', reason: 'The agentkit signature is invalid.' }

      try {
        const expires = Date.parse(payload.issuedAt) + (maxAge + Constants.clockSkew) * 1000
        const key = `world:${payload.address.toLowerCase()}:${payload.nonce}`
        if (!(await Store.tryClaim(config.nonceStore, key, expires)))
          return { status: 'invalid', reason: 'The agentkit nonce has already been used.' }
      } catch {
        return { status: 'unavailable', reason: 'Replay protection is unavailable.' }
      }

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
      return {
        status: 'valid',
        value: Object.freeze({ address: payload.address, chainId: payload.chainId, humanId }),
      }
    },
  }
}

export declare namespace verifier {
  type Config = {
    /** Atomically claims each message nonce, shared across instances. */
    nonceStore: Store.AtomicStore
    /** Where to read AgentBook. Defaults to the canonical World Chain deployment. */
    agentBook?: agentBook.Config | undefined
    /**
     * RPC URLs by signing chain ID, to verify smart-account (ERC-1271 and ERC-6492) signatures
     * from payloads typed `eip1271`.
     * World Chain (480), where AgentBook lives, uses its public RPC unless set here. Add another
     * chain only if its accounts are controlled as on World Chain: the same address can belong to
     * someone else on another chain, and AgentBook does not record which chain registered it.
     * Smart accounts on other chains are rejected.
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
}

/** Public RPC for World Chain, where AgentBook resolves the human. */
const defaultRpcUrls: Record<number, string> = {
  [worldchain.id]: worldchain.rpcUrls.default.http[0],
}

/** One client per allowed signing chain: never an RPC the request names. */
function signingClients(config: verifier.Config): Map<number, SigningClient> {
  const urls = { ...defaultRpcUrls, ...config.rpcUrls }
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
    if (!/^eip155:\d+$/.test(value.chainId as string)) return undefined
    if (!/^0x[0-9a-fA-F]{40}$/.test(value.address as string)) return undefined
    return value as Types.Payload
  } catch {
    return undefined
  }
}

/** Returns why a message does not fit the request, or `undefined` when it does. */
function check(payload: Types.Payload, url: URL, maxAge: number): string | undefined {
  if (payload.domain !== url.hostname) return 'The agentkit message is for another domain.'
  try {
    if (new URL(payload.uri).host !== url.host) return 'The agentkit message is for another URI.'
  } catch {
    return 'The agentkit message URI is invalid.'
  }
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
