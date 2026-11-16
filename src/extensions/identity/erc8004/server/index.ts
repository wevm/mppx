import {
  createClient,
  getAddress,
  hashMessage,
  http,
  isAddressEqual,
  recoverMessageAddress,
  zeroAddress,
  type Address,
  type Client,
  type Hex,
} from 'viem'
import { readContract } from 'viem/actions'

import type * as Identity from '../../../../identity/Types.js'
import * as Store from '../../../../Store.js'
import { Constants } from '../Constants.js'
import * as Agent from '../internal/Agent.js'
import type * as Types from '../Types.js'

const abi = [
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const

/**
 * Creates an ERC-8004 agent verifier for one API.
 *
 * - `verifier` requires a request signed by the agent's wallet, as the Identity Registry's
 *   `getAgentWallet` names it: an EOA signature, or ERC-1271 for a contract or configurable account.
 * - `paymentCheck` accepts a `tempo` charge the agent's wallet signed (a transaction or proof), so
 *   the payment itself proves the agent. For anything else (no Credential, transaction hashes,
 *   sessions, Zones, other methods) it requires the signature.
 *
 * @example
 * ```ts
 * const agents = Erc8004.Server.create({ store })
 * mppx.charge({ amount: '0.01', identity: { request: [agents.verifier], payment: agents.paymentCheck } })
 * ```
 */
export function create(config: create.Config = {}): Erc8004 {
  const chainId = config.chainId ?? Constants.chainId
  const registry = getAddress(config.registry ?? Constants.identityRegistry)
  if (!config.client && !config.rpcUrl && chainId !== Constants.chainId)
    throw new TypeError('Pass `client` or `rpcUrl` for a chain other than Tempo mainnet.')
  const client =
    config.client ?? createClient({ transport: http(config.rpcUrl ?? Constants.rpcUrl) })
  const store = config.store
  // One lookup per request, so the verifier and payment check share it and spend a nonce once.
  const agents = new WeakMap<Request, Promise<Identity.Verification<Types.Agent>>>()
  const signed = new WeakMap<Request, Promise<Identity.Verification<Types.Agent>>>()

  const invalid = (reason: string) => ({ status: 'invalid', reason }) as const

  /** Reads the request's agent and its wallet from the registry. */
  async function lookup(request: Request): Promise<Identity.Verification<Types.Agent>> {
    const id = request.headers.get(Constants.idHeader)
    if (!id) return { status: 'missing', reason: 'Sign the request as an ERC-8004 agent.' }
    const agent = Agent.parse(id)
    if (!agent || agent.chainId !== chainId || !isAddressEqual(agent.registry, registry))
      return invalid(`The agent must be in the Identity Registry ${registry} on chain ${chainId}.`)
    let wallet: Address
    try {
      wallet = await readContract(client, {
        abi,
        address: registry,
        args: [agent.agentId],
        functionName: 'getAgentWallet',
      })
    } catch {
      return { status: 'unavailable', reason: 'The Identity Registry is unavailable.' }
    }
    if (isAddressEqual(wallet, zeroAddress))
      return { status: 'forbidden', reason: 'The agent has no wallet.' }
    return {
      status: 'valid',
      value: { agentId: agent.agentId, id: Agent.format(agent), wallet: getAddress(wallet) },
    }
  }

  /** Checks that the agent's wallet signed this request. */
  async function verifySignature(request: Request): Promise<Identity.Verification<Types.Agent>> {
    const result = await getAgent(request)
    if (result.status !== 'valid') return result
    const [created = '', nonce = '', signature = '', ...rest] = (
      request.headers.get(Constants.signatureHeader) ?? ''
    ).split('.')
    if (
      rest.length > 0 ||
      !/^\d{1,12}$/.test(created) ||
      !nonce ||
      !/^0x[0-9a-fA-F]+$/.test(signature)
    )
      return invalid('The agent signature is missing or malformed.')
    const now = Math.floor(Date.now() / 1_000)
    const expires = Number(created) + Constants.maxAge + Constants.clockTolerance
    if (Number(created) > now + Constants.clockTolerance || expires < now)
      return invalid('The agent signature has expired.')

    const message = Agent.message({
      created: Number(created),
      id: request.headers.get(Constants.idHeader)!,
      nonce,
      request,
    })
    if (!(await signedBy(result.value.wallet, message, signature as Hex)))
      return invalid("The agent's wallet did not sign the request.")
    if (store) {
      const key = `mppx:erc8004:nonce:${hashMessage(`${result.value.id}:${nonce}`)}`
      const claimed = await Promise.resolve()
        .then(() => Store.tryClaim(store, key, expires * 1_000))
        .catch(() => null)
      if (claimed === null)
        return { status: 'unavailable', reason: 'The replay store is unavailable.' }
      if (!claimed) return invalid('The agent signature was already used.')
    }
    return result
  }

  /** Returns whether `wallet` signed `message`: by EOA recovery, else by ERC-1271. */
  async function signedBy(wallet: Address, message: string, signature: Hex) {
    const recovered = await recoverMessageAddress({ message, signature }).catch(() => undefined)
    if (recovered && isAddressEqual(recovered, wallet)) return true
    const magic = await readContract(client, {
      abi,
      address: wallet,
      args: [hashMessage(message), signature],
      functionName: 'isValidSignature',
    }).catch(() => undefined)
    return magic === '0x1626ba7e'
  }

  function getAgent(request: Request) {
    let result = agents.get(request)
    if (!result) agents.set(request, (result = lookup(request)))
    return result
  }

  function getSigned(request: Request) {
    let result = signed.get(request)
    if (!result) signed.set(request, (result = verifySignature(request)))
    return result
  }

  /** Runs `allow` on a verified agent. */
  async function allowed(
    result: Identity.Verification<Types.Agent>,
  ): Promise<Identity.Verification<Types.Agent>> {
    if (result.status !== 'valid' || !config.allow || (await config.allow(result.value)))
      return result
    return { status: 'forbidden', reason: 'This agent may not call this API.' }
  }

  return {
    verifier: { verify: async (request) => allowed(await getSigned(request)) },
    paymentCheck: {
      requires: [{ type: Constants.type }],
      async verify({ challenge, credential, request }) {
        // Only a tempo charge the source signed binds it to the payer: a transaction or a proof.
        // A hash credential doesn't (the charge's validateSender can accept another payer), and
        // neither do sessions, Zones or other methods, so they need the agent's signature instead.
        const type = (credential?.payload as { type?: unknown } | undefined)?.type
        if (
          !credential ||
          challenge.method !== 'tempo' ||
          challenge.intent !== 'charge' ||
          (type !== 'transaction' && type !== 'proof')
        )
          return allowed(await getSigned(request))
        const agent = await getAgent(request)
        if (agent.status !== 'valid') return agent
        // The source is a did:pkh:eip155:<chainId>:<address>.
        const parts = credential.source?.split(':') ?? []
        const [did, pkh, namespace, chain, address = ''] = parts
        if (
          parts.length !== 5 ||
          did !== 'did' ||
          pkh !== 'pkh' ||
          namespace !== 'eip155' ||
          chain !== String(chainId) ||
          !/^0x[0-9a-fA-F]{40}$/.test(address)
        )
          return invalid(`The payment must name its source account on chain ${chainId}.`)
        if (!isAddressEqual(address as Address, agent.value.wallet))
          return { status: 'forbidden', reason: "The payment is not from the agent's wallet." }
        return allowed(agent)
      },
    },
  }
}

export declare namespace create {
  type Config = {
    /** Decides whether a verified agent may call the API, such as by its ID or reputation. */
    readonly allow?: ((agent: Types.Agent) => boolean | Promise<boolean>) | undefined
    /** The registry's chain. Payments must settle on it too. @default 4217 (Tempo mainnet) */
    readonly chainId?: number | undefined
    /** A viem client for the registry's chain. @default an HTTP client for `rpcUrl` */
    readonly client?: Client | undefined
    /** The Identity Registry. @default '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' */
    readonly registry?: Address | undefined
    /** RPC URL of the registry's chain. @default 'https://rpc.tempo.xyz' */
    readonly rpcUrl?: string | undefined
    /** Accepts each request signature once. Without it, a signature can be replayed for six minutes. */
    readonly store?: Store.AtomicStore | undefined
  }
}

/** An ERC-8004 agent verifier from {@link create}. */
export type Erc8004 = {
  /** A request-stage verifier: requires a request signed by the agent's wallet, before any 402. */
  readonly verifier: Identity.Verifier<Types.Agent>
  /** A payment check: requires that the agent's wallet paid. */
  readonly paymentCheck: Identity.PaymentCheck<Types.Agent>
}
