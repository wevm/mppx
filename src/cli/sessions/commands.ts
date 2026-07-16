import { Errors } from 'incur'
import type { Address, Hex } from 'viem'
import { createClient, http } from 'viem'
import { tempo as tempoMainnet, tempoModerato } from 'viem/tempo/chains'

import { normalizeHeaders } from '../../client/internal/Fetch.js'
import { canSignDescriptor } from '../../tempo/session/client/CredentialState.js'
import { isTempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import * as Chain from '../../tempo/session/precompile/Chain.js'
import * as Channel from '../../tempo/session/precompile/Channel.js'
import { resolveAccountName, resolveLocalAccount } from '../account.js'
import { isTempoAccount, resolveChain, resolveRpcUrl, type Network } from '../utils.js'
import { closeWithSessionManager } from './Manager.js'
import {
  createSessionRegistry,
  type ManagedSession,
  type SessionRegistry,
  type SessionScope,
  toChannelStore,
} from './store.js'

/** Stable JSON projection of a managed session. */
export type SessionOutput = {
  status: ManagedSession['status']
  channelId: Hex
  account?: string | undefined
  payer: Address
  payee: Address
  authorizedSigner: Address
  token: Address
  escrow: Address
  chainId: number
  cumulativeAmount: string
  confirmedSpend: string
  deposit: string
  units: number
  resourceUrl: string
  createdAt: string
  updatedAt: string
}

/** Successful close command result. */
export type SessionCloseOutput = {
  channelId: Hex
  status: 'closed' | 'already-closed'
  spent: string
  txHash?: Hex | undefined
}

/** Filters accepted by `mppx sessions list`. */
export type SessionListOptions = {
  account?: string | undefined
  network?: Network | undefined
}

/** Options accepted by one explicit session close. */
export type SessionCloseOptions = {
  account?: string | undefined
  headers?: readonly string[] | undefined
  network?: Network | undefined
  resourceUrl?: string | undefined
  rpcUrl?: string | undefined
}

function networkChainId(network: Network): number {
  return network === 'mainnet' ? tempoMainnet.id : tempoModerato.id
}

function networkForChain(chainId: number): Network | undefined {
  if (chainId === tempoMainnet.id) return 'mainnet'
  if (chainId === tempoModerato.id) return 'testnet'
  return undefined
}

function exactResourceUrl(value: string): string {
  const protocol = new URL(value).protocol
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new Error('Invalid session resource URL.')
  const fragment = value.indexOf('#')
  return fragment === -1 ? value : value.slice(0, fragment)
}

function parseHeaders(values: readonly string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const value of values ?? []) {
    const index = value.indexOf(':')
    if (index === -1)
      throw new Errors.IncurError({
        code: 'INVALID_HEADER',
        message: `Invalid header format: ${value}`,
        exitCode: 2,
      })
    headers[value.slice(0, index).trim()] = value.slice(index + 1).trim()
  }
  return headers
}

function outputSession(record: ManagedSession): SessionOutput {
  return {
    status: record.status,
    channelId: record.channel.channelId,
    ...(record.account.name && { account: record.account.name }),
    payer: record.channel.descriptor.payer,
    payee: record.channel.descriptor.payee,
    authorizedSigner: record.channel.descriptor.authorizedSigner,
    token: record.channel.descriptor.token,
    escrow: record.channel.escrow,
    chainId: record.channel.chainId,
    cumulativeAmount: record.channel.cumulativeAmount.toString(),
    confirmedSpend: record.spent.toString(),
    deposit: record.channel.deposit.toString(),
    units: record.units,
    resourceUrl: record.endpoint,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Lists durable sessions with optional account and network filtering. */
export async function listSessions(
  options: SessionListOptions = {},
  registry: SessionRegistry = createSessionRegistry(),
): Promise<SessionOutput[]> {
  const records = await registry.list()
  return records
    .filter((record) => {
      if (options.account && record.account.name !== options.account) return false
      if (options.network && record.channel.chainId !== networkChainId(options.network))
        return false
      return true
    })
    .map(outputSession)
}

/** Returns one durable session by full channel ID. */
export async function viewSession(
  channelId: string,
  registry: SessionRegistry = createSessionRegistry(),
): Promise<SessionOutput> {
  const record = await registry.get(channelId)
  if (record) return outputSession(record)
  throw new Errors.IncurError({
    code: 'SESSION_NOT_FOUND',
    message: `Session ${channelId} was not found.`,
    exitCode: 2,
  })
}

async function resolveCloseAccount(record: ManagedSession, accountOverride?: string | undefined) {
  const accountName = accountOverride ?? record.account.name
  const resolvedName = resolveAccountName(accountName)
  if (!process.env.MPPX_PRIVATE_KEY?.trim() && isTempoAccount(resolvedName))
    throw new Errors.IncurError({
      code: 'UNSUPPORTED_ACCOUNT',
      message: 'Persistent sessions require an mppx account or MPPX_PRIVATE_KEY.',
      exitCode: 2,
    })
  const resolved = await resolveLocalAccount(accountName).catch((cause: unknown) => {
    throw new Errors.IncurError({
      code: 'ACCOUNT_NOT_FOUND',
      message: cause instanceof Error ? cause.message : 'No account found.',
      exitCode: 69,
      ...(cause instanceof Error && { cause }),
    })
  })
  if (!canSignDescriptor(resolved.account, record.channel.descriptor))
    throw new Errors.IncurError({
      code: 'SESSION_ACCOUNT_MISMATCH',
      message: `Account ${resolved.account.address} cannot sign for session ${record.channel.channelId}.`,
      exitCode: 2,
    })
  return resolved
}

async function resolveCloseClient(
  chainId: number,
  options: Pick<SessionCloseOptions, 'network' | 'rpcUrl'>,
) {
  if (options.network && networkChainId(options.network) !== chainId)
    throw new Errors.IncurError({
      code: 'CHAIN_MISMATCH',
      message: `Session uses chainId ${chainId}, not ${options.network}.`,
      exitCode: 2,
    })
  const network = options.network ?? networkForChain(chainId)
  const rpcUrl = resolveRpcUrl(options.rpcUrl, { network })
  const chain = await resolveChain({ network, rpcUrl })
  if (chain.id !== chainId)
    throw new Errors.IncurError({
      code: 'CHAIN_MISMATCH',
      message: `Session uses chainId ${chainId}, but RPC is chainId ${chain.id}.`,
      exitCode: 2,
    })
  return createClient({ chain, transport: http(rpcUrl) })
}

function sessionScope(record: ManagedSession): SessionScope {
  return {
    payer: record.channel.descriptor.payer,
    payee: record.channel.descriptor.payee,
    token: record.channel.descriptor.token,
    escrow: record.channel.escrow,
    chainId: record.channel.chainId,
  }
}

/** Closes one durable session, retaining `closing` state for every ambiguous failure. */
export async function closeSession(
  channelId: string,
  options: SessionCloseOptions = {},
  registry: SessionRegistry = createSessionRegistry(),
): Promise<SessionCloseOutput> {
  const candidate = await registry.get(channelId)
  if (!candidate)
    throw new Errors.IncurError({
      code: 'SESSION_NOT_FOUND',
      message: `Session ${channelId} was not found.`,
      exitCode: 2,
    })
  const scope = sessionScope(candidate)
  const lock = await registry.acquire(scope)
  try {
    const record = await registry.get(channelId)
    if (!record)
      throw new Errors.IncurError({
        code: 'SESSION_NOT_FOUND',
        message: `Session ${channelId} was not found.`,
        exitCode: 2,
      })
    const resolvedAccount = await resolveCloseAccount(record, options.account)
    const client = await resolveCloseClient(record.channel.chainId, options)
    const expectedId = Channel.computeId({
      ...record.channel.descriptor,
      escrow: record.channel.escrow,
      chainId: record.channel.chainId,
    })
    if (expectedId.toLowerCase() !== record.channel.channelId.toLowerCase())
      throw new Errors.IncurError({
        code: 'SESSION_STATE_INVALID',
        message: 'Stored descriptor does not derive the session channel ID.',
        exitCode: 65,
      })

    const state = await Chain.getChannelState(
      client as never,
      record.channel.channelId,
      record.channel.escrow,
    )
    if (state.deposit === 0n) {
      await registry.remove(record.channel.channelId)
      return {
        channelId: record.channel.channelId,
        status: 'already-closed',
        spent: record.spent.toString(),
      }
    }

    const endpoint = exactResourceUrl(options.resourceUrl ?? record.endpoint)
    const account = {
      ...(resolvedAccount.source === 'keychain' && { name: resolvedAccount.accountName }),
      address: resolvedAccount.account.address,
    }
    const closing = await registry.upsert({
      status: 'closing',
      channel: record.channel,
      account,
      endpoint,
      challenge: record.challenge,
      ...(record.receipt && { receipt: record.receipt }),
      spent: record.spent,
      units: record.units,
    })
    const headers = parseHeaders(options.headers)
    let latestChallenge = closing.challenge
    const closeFetch: typeof globalThis.fetch = async (input, init) =>
      globalThis.fetch(input, {
        ...init,
        headers: { ...headers, ...normalizeHeaders(init?.headers) },
      })
    const result = await closeWithSessionManager({
      channel: closing.channel,
      challenge: isTempoSessionChallenge(closing.challenge)
        ? closing.challenge
        : (() => {
            throw new Error('Stored session challenge is not tempo/session.')
          })(),
      fetch: closeFetch,
      input: endpoint,
      spent: closing.spent,
      async onChallenge(challenge) {
        latestChallenge = challenge
        await registry.upsert({
          status: 'closing',
          channel: closing.channel,
          account,
          endpoint,
          challenge,
          ...(closing.receipt && { receipt: closing.receipt }),
          spent: closing.spent,
          units: closing.units,
        })
      },
      manager: {
        account: resolvedAccount.account,
        client,
        channelStore: toChannelStore(registry, {
          scope,
          selection: closing.channel.channelId,
          context: () => ({
            status: 'closing',
            account,
            endpoint,
            challenge: latestChallenge,
            ...(closing.receipt && { receipt: closing.receipt }),
            spent: closing.spent,
            units: closing.units,
          }),
        }),
      },
    })
    await registry.remove(closing.channel.channelId)
    return {
      channelId: closing.channel.channelId,
      status: 'closed',
      spent: result.receipt.spent,
      txHash: result.receipt.txHash,
    }
  } finally {
    await lock.release()
  }
}

/** Closes matching managed sessions sequentially and preserves individual failures. */
export async function closeAllSessions(
  options: Pick<SessionCloseOptions, 'account' | 'network'> = {},
  registry: SessionRegistry = createSessionRegistry(),
  close: typeof closeSession = closeSession,
): Promise<{ closed: SessionCloseOutput[]; failed: { channelId: string; message: string }[] }> {
  const records = (await registry.list()).filter(
    (record) =>
      (!options.account || record.account.name === options.account) &&
      (!options.network || record.channel.chainId === networkChainId(options.network)),
  )
  const closed: SessionCloseOutput[] = []
  const failed: { channelId: string; message: string }[] = []
  for (const record of records) {
    try {
      closed.push(
        await close(
          record.channel.channelId,
          { account: options.account, network: options.network },
          registry,
        ),
      )
    } catch (error) {
      failed.push({
        channelId: record.channel.channelId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { closed, failed }
}
