import { createClient, http } from 'viem'

import {
  createSessionAdministration,
  createSqliteChannelStore,
  type SessionAdministration,
  type SessionCloseSelection,
} from '../../client/node.js'
import { resolvePersistentAccount } from '../account.js'
import { resolveChain, resolveRpcUrl, type Network } from '../utils.js'

/** Shared CLI connection options for session administration. */
export type SessionCommandOptions = {
  account?: string | undefined
  network?: Network | undefined
  rpcUrl?: string | undefined
}

/** JSON-safe projection returned by MPPx session list and sync commands. */
export type SessionCommandRecord = {
  acceptedCumulative: string
  chainId: number
  channelId: string
  closeRequestedAt: number
  createdAt: number
  cumulativeAmount: string
  deposit: string
  graceReadyAt: number
  lastUsedAt: number
  origin: string
  requestUrl: string
  state: string
}

async function withAdministration<Result>(
  options: SessionCommandOptions,
  operation: (administration: SessionAdministration) => Promise<Result> | Result,
): Promise<Result> {
  const rpcUrl = resolveRpcUrl(options.rpcUrl, { network: options.network })
  const chain = await resolveChain({ network: options.network, rpcUrl })
  const client = createClient({ chain, transport: http(rpcUrl) })
  const store = createSqliteChannelStore()
  try {
    const resolved = await resolvePersistentAccount(options.account)
    return await operation(
      createSessionAdministration({
        account: resolved.account,
        client,
        store,
      }),
    )
  } finally {
    store.close()
  }
}

/** Lists locally retained TIP-1034 sessions without making network requests. */
export async function listPersistentSessions(
  options: SessionCommandOptions,
): Promise<SessionCommandRecord[]> {
  return withAdministration(options, (administration) =>
    administration.list().map(serializeSession),
  )
}

/** Recovers and reconciles TIP-1034 sessions against Tempo on-chain state. */
export async function syncPersistentSessions(
  options: SessionCommandOptions,
): Promise<SessionCommandRecord[]> {
  return withAdministration(options, async (administration) =>
    (await administration.sync()).map(serializeSession),
  )
}

/** Closes selected TIP-1034 sessions using the shared MPPx administration API. */
export async function closePersistentSessions(
  options: SessionCommandOptions & SessionCloseSelection,
) {
  return withAdministration(options, (administration) => administration.close(options))
}

function serializeSession(
  record: ReturnType<SessionAdministration['list']>[number],
): SessionCommandRecord {
  return {
    acceptedCumulative: record.acceptedCumulative.toString(),
    chainId: record.entry.chainId,
    channelId: record.entry.channelId,
    closeRequestedAt: record.closeRequestedAt,
    createdAt: record.createdAt,
    cumulativeAmount: record.entry.cumulativeAmount.toString(),
    deposit: record.entry.deposit.toString(),
    graceReadyAt: record.graceReadyAt,
    lastUsedAt: record.lastUsedAt,
    origin: record.origin,
    requestUrl: record.requestUrl,
    state: record.state,
  }
}
