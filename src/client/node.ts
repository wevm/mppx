import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Account, Address, Client, Hex } from 'viem'
import { getBlockNumber, getLogs, readContract } from 'viem/actions'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as ChannelOps from '../tempo/session/client/ChannelOps.js'
import type { ChannelEntry } from '../tempo/session/client/ChannelOps.js'
import {
  deserializeEntry,
  entryKey,
  serializeEntry,
  type ChannelStore,
  type StoredChannel,
} from '../tempo/session/client/ChannelStore.js'
import { isTempoSessionChallenge } from '../tempo/session/client/Transports.js'
import * as Chain from '../tempo/session/precompile/Chain.js'
import { escrowAbi } from '../tempo/session/precompile/escrow.abi.js'
import { tip20ChannelEscrow } from '../tempo/session/precompile/Protocol.js'

const schemaVersion = 2

/** Options for the Node SQLite-backed payer channel store. */
export type SqliteChannelStoreOptions = {
  /** Service namespace, normally the protected API origin. */
  namespace?: string | undefined
  /** SQLite file path. Defaults to the shared Tempo channel database. */
  path?: string | undefined
  /** Full protected URL retained for CLI session-management requests. */
  requestUrl?: string | undefined
}

/** A SQLite-backed channel store that can release its database handle. */
export type SqliteChannelStore = ChannelStore & {
  /** Absolute or caller-supplied path opened by this store. */
  readonly path: string
  /** Removes a channel by its canonical channel ID. */
  deleteChannel(channelId: Hex): void
  /** Returns all TIP-1034 sessions known to this database. */
  listSessions(options?: SqliteSessionListOptions): SqliteSessionRecord[]
  /** Returns the signer of the most recently used active session for this service. */
  latestAuthorizedSigner(): Address | undefined
  /** Persists a TIP-1034 session discovered outside the normal request path. */
  setSession(record: SqliteSessionRecord): void
  /** Updates durable close state for a channel. */
  updateSessionState(
    channelId: Hex,
    state: SqliteSessionState,
    timing?: { closeRequestedAt?: number | undefined; graceReadyAt?: number | undefined },
  ): void
  /** Closes the underlying SQLite connection. */
  close(): void
}

/** Durable lifecycle state attached to a SQLite session row. */
export type SqliteSessionState = 'active' | 'closing' | 'finalizable' | 'finalized' | 'orphaned'

/** Filters accepted by {@link SqliteChannelStore.listSessions}. */
export type SqliteSessionListOptions = {
  /** Restrict results to one chain. */
  chainId?: number | undefined
  /** Restrict results to one service origin. */
  origin?: string | undefined
  /** Restrict results to one payer/root account. */
  payer?: Address | undefined
}

/** Complete durable TIP-1034 session metadata stored by Node clients. */
export type SqliteSessionRecord = {
  /** Highest cumulative amount acknowledged by the service, when known. */
  acceptedCumulative: bigint
  /** Unix timestamp when close was requested, or zero while open. */
  closeRequestedAt: number
  /** Unix timestamp when withdrawal becomes available, or zero while open. */
  graceReadyAt: number
  /** Service origin owning this payment namespace. */
  origin: string
  /** Complete reusable client channel entry. */
  entry: ChannelEntry
  /** Original protected URL, used for cooperative close. */
  requestUrl: string
  /** Durable local lifecycle state. */
  state: SqliteSessionState
  /** First-seen Unix timestamp. */
  createdAt: number
  /** Last-used Unix timestamp. */
  lastUsedAt: number
}

type ChannelRow = {
  accepted_cumulative: string
  chain_id: number
  channel_id: string
  close_requested_at: number
  created_at: number
  cumulative_amount: string
  deposit: string
  descriptor_json: string | null
  entry_json: string | null
  escrow_contract: string
  grace_ready_at: number
  last_used_at: number
  origin: string
  payer: string
  request_url: string
  session_protocol: string
  state: string
}

/** Returns the default Tempo channel database path. */
export function defaultChannelDatabasePath(): string {
  return join(homedir(), '.tempo', 'wallet', 'channels.db')
}

/**
 * Creates a synchronous Node SQLite implementation of {@link ChannelStore}.
 *
 * The schema is compatible with the existing `channels` table, so a fresh MPPx
 * client can reuse v2 session records without a separate migration command. A
 * namespace keeps identical payment scopes at different services isolated.
 */
export function createSqliteChannelStore(
  options: SqliteChannelStoreOptions = {},
): SqliteChannelStore {
  const path = options.path ?? defaultChannelDatabasePath()
  const namespace = options.namespace ?? ''
  const requestUrl = options.requestUrl ?? namespace
  const origin = resolveOrigin(requestUrl, namespace)
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  ensureSchema(database)

  const getRow = database.prepare(`SELECT channel_id, chain_id, escrow_contract,
      cumulative_amount, deposit, descriptor_json, entry_json, state
    FROM channels
    WHERE scope_key = ?`)
  const listRows = database.prepare(`SELECT channel_id, chain_id, escrow_contract,
      cumulative_amount, deposit, descriptor_json, entry_json, state,
      accepted_cumulative, close_requested_at, grace_ready_at, origin, request_url,
      payer, session_protocol, created_at, last_used_at
    FROM channels
    WHERE session_protocol = 'v2' AND descriptor_json IS NOT NULL
    ORDER BY last_used_at DESC`)
  const getChannelById = database.prepare('SELECT channel_id FROM channels WHERE channel_id = ?')
  const getLatestAuthorizedSigner = database.prepare(`SELECT authorized_signer FROM channels
    WHERE origin = ? AND state = 'active' AND session_protocol = 'v2'
      AND scope_key IS NOT NULL
    ORDER BY last_used_at DESC LIMIT 1`)
  const deleteScope = database.prepare('DELETE FROM channels WHERE scope_key = ?')
  const deleteChannel = database.prepare('DELETE FROM channels WHERE channel_id = ?')
  const deleteOtherScopeChannel = database.prepare(
    'DELETE FROM channels WHERE scope_key = ? AND channel_id <> ?',
  )
  const updateSessionState = database.prepare(`UPDATE channels
    SET state = ?, close_requested_at = ?, grace_ready_at = ?
    WHERE channel_id = ?`)
  const updateSession = database.prepare(`UPDATE channels SET
      version = ?, scope_key = ?, origin = ?, request_url = ?, chain_id = ?,
      escrow_contract = ?, token = ?, payee = ?, payer = ?, authorized_signer = ?,
      salt = ?, session_protocol = 'v2', descriptor_json = ?, entry_json = ?,
      deposit = ?, cumulative_amount = ?, accepted_cumulative = ?, state = ?,
      close_requested_at = ?, grace_ready_at = ?, created_at = ?, last_used_at = ?
    WHERE channel_id = ?`)
  const upsert = database.prepare(`INSERT INTO channels (
      channel_id, version, scope_key, origin, request_url, chain_id, escrow_contract, token,
      payee, payer, authorized_signer, salt, session_protocol, descriptor_json, entry_json,
      deposit, cumulative_amount, accepted_cumulative, challenge_echo, state,
      close_requested_at, grace_ready_at, created_at, last_used_at, server_spent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v2', ?, ?, ?, ?, '0', '{}', 'active',
      0, 0, ?, ?, '0')
    ON CONFLICT(channel_id) DO UPDATE SET
      version = excluded.version,
      scope_key = excluded.scope_key,
      origin = excluded.origin,
      request_url = excluded.request_url,
      chain_id = excluded.chain_id,
      escrow_contract = excluded.escrow_contract,
      token = excluded.token,
      payee = excluded.payee,
      payer = excluded.payer,
      authorized_signer = excluded.authorized_signer,
      salt = excluded.salt,
      session_protocol = excluded.session_protocol,
      descriptor_json = excluded.descriptor_json,
      entry_json = excluded.entry_json,
      deposit = excluded.deposit,
      cumulative_amount = excluded.cumulative_amount,
      state = 'active',
      close_requested_at = 0,
      last_used_at = excluded.last_used_at`)

  return {
    path,
    get(key) {
      const row = getRow.get(scopedKey(namespace, key)) as ChannelRow | undefined
      return row ? entryFromRow(row) : undefined
    },
    set(entry) {
      const scopeKey = scopedKey(namespace, entryKey(entry))
      database.exec('BEGIN IMMEDIATE')
      try {
        const existing = getRow.get(scopeKey) as ChannelRow | undefined
        const merged = mergeEntry(existing ? entryFromRow(existing) : undefined, entry)
        const stored = serializeEntry(merged)
        const now = Math.floor(Date.now() / 1_000)
        deleteOtherScopeChannel.run(scopeKey, merged.channelId)
        upsert.run(
          merged.channelId,
          schemaVersion,
          scopeKey,
          origin,
          requestUrl,
          merged.chainId,
          merged.escrow,
          merged.descriptor.token,
          merged.descriptor.payee,
          merged.descriptor.payer,
          merged.descriptor.authorizedSigner,
          merged.descriptor.salt,
          JSON.stringify(merged.descriptor),
          JSON.stringify(stored),
          merged.deposit.toString(),
          merged.cumulativeAmount.toString(),
          now,
          now,
        )
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    delete(key) {
      deleteScope.run(scopedKey(namespace, key))
    },
    deleteChannel(channelId) {
      deleteChannel.run(channelId.toLowerCase())
    },
    listSessions(options = {}) {
      return (listRows.all() as ChannelRow[])
        .filter((row) => options.chainId === undefined || row.chain_id === options.chainId)
        .filter(
          (row) =>
            options.origin === undefined ||
            row.origin.toLowerCase() === normalizeOrigin(options.origin),
        )
        .filter(
          (row) =>
            options.payer === undefined || row.payer.toLowerCase() === options.payer.toLowerCase(),
        )
        .map(sessionRecordFromRow)
    },
    latestAuthorizedSigner() {
      const row = getLatestAuthorizedSigner.get(origin) as
        | { authorized_signer: Address }
        | undefined
      return row?.authorized_signer
    },
    setSession(record) {
      const scopeKey = record.origin
        ? scopedKey(record.origin || namespace, entryKey(record.entry))
        : null
      const stored = serializeEntry(record.entry)
      if (scopeKey) deleteOtherScopeChannel.run(scopeKey, record.entry.channelId)
      if (getChannelById.get(record.entry.channelId)) {
        updateSession.run(
          schemaVersion,
          scopeKey,
          record.origin,
          record.requestUrl,
          record.entry.chainId,
          record.entry.escrow,
          record.entry.descriptor.token,
          record.entry.descriptor.payee,
          record.entry.descriptor.payer,
          record.entry.descriptor.authorizedSigner,
          record.entry.descriptor.salt,
          JSON.stringify(record.entry.descriptor),
          JSON.stringify(stored),
          record.entry.deposit.toString(),
          record.entry.cumulativeAmount.toString(),
          record.acceptedCumulative.toString(),
          record.state,
          record.closeRequestedAt,
          record.graceReadyAt,
          record.createdAt,
          record.lastUsedAt,
          record.entry.channelId,
        )
        return
      }
      upsert.run(
        record.entry.channelId,
        schemaVersion,
        scopeKey,
        record.origin,
        record.requestUrl,
        record.entry.chainId,
        record.entry.escrow,
        record.entry.descriptor.token,
        record.entry.descriptor.payee,
        record.entry.descriptor.payer,
        record.entry.descriptor.authorizedSigner,
        record.entry.descriptor.salt,
        JSON.stringify(record.entry.descriptor),
        JSON.stringify(stored),
        record.entry.deposit.toString(),
        record.entry.cumulativeAmount.toString(),
        record.createdAt,
        record.lastUsedAt,
      )
      database
        .prepare(`UPDATE channels SET
          accepted_cumulative = ?, state = ?, close_requested_at = ?, grace_ready_at = ?
          WHERE channel_id = ?`)
        .run(
          record.acceptedCumulative.toString(),
          record.state,
          record.closeRequestedAt,
          record.graceReadyAt,
          record.entry.channelId,
        )
    },
    updateSessionState(channelId, state, timing = {}) {
      updateSessionState.run(
        state,
        timing.closeRequestedAt ?? 0,
        timing.graceReadyAt ?? 0,
        channelId.toLowerCase(),
      )
    },
    close() {
      database.close()
    },
  }
}

/** Options for {@link createSessionAdministration}. */
export type SessionAdministrationOptions = {
  /** Payer/root account authorized to manage the stored channels. */
  account: Account
  /** Viem client connected to the channel chain. */
  client: Client
  /** SQLite store shared with normal session requests. */
  store: SqliteChannelStore
  /** Fetch override used for cooperative close. */
  fetch?: typeof globalThis.fetch | undefined
  /** Number of recent blocks inspected while recovering unknown channels. @default 100000 */
  logScanDepth?: bigint | undefined
  /** Maximum block span per recovery log query. @default 50000 */
  logQueryBlockRange?: bigint | undefined
  /** Blocks omitted from the unstable chain head while recovering. @default 10 */
  logHeadMargin?: bigint | undefined
  /** Clock override used by deterministic callers and tests. */
  now?: (() => number) | undefined
  /** Resolves the local access key authorized by a retained channel descriptor. */
  resolveAccount?: ((authorizedSigner: Address) => Account | Promise<Account>) | undefined
}

/** Selection accepted by session close and dry-run operations. */
export type SessionCloseSelection = {
  /** Close every stored session for the configured payer and chain. */
  all?: boolean | undefined
  /** Ask the service for a cooperative close instead of starting the grace period on-chain. */
  cooperative?: boolean | undefined
  /** Withdraw only sessions whose grace periods have elapsed. */
  finalize?: boolean | undefined
  /** Close only recovered sessions that have no known service origin. */
  orphaned?: boolean | undefined
  /** Channel ID or service URL/origin. */
  target?: string | undefined
}

/** Result of one session close attempt. */
export type SessionCloseResult = {
  /** Canonical channel ID. */
  channelId: Hex
  /** Error message when this target failed. */
  error?: string | undefined
  /** Service origin, when known. */
  origin?: string | undefined
  /** Seconds remaining before a pending close can be withdrawn. */
  remainingSeconds?: number | undefined
  /** Resulting lifecycle status. */
  status: 'closed' | 'pending' | 'error'
}

/** Summary returned by {@link SessionAdministration.close}. */
export type SessionCloseSummary = {
  closed: number
  failed: number
  pending: number
  results: SessionCloseResult[]
}

/** Durable TIP-1034 session listing, recovery, reconciliation, and close operations. */
export type SessionAdministration = {
  /** Closes selected sessions cooperatively or through request-close/withdraw transactions. */
  close(selection: SessionCloseSelection): Promise<SessionCloseSummary>
  /** Returns selected durable sessions without network access. */
  list(options?: SqliteSessionListOptions): SqliteSessionRecord[]
  /** Recovers payer channels from logs and reconciles every local row with on-chain state. */
  sync(options?: { discover?: boolean | undefined }): Promise<SqliteSessionRecord[]>
}

/**
 * Creates the Node session-administration API shared by MPPx and wallet CLIs.
 *
 * Normal request rehydration remains owned by `tempo.session.manager()`. This
 * API manages the same SQLite rows for listing, cold-state recovery, close,
 * and final withdrawal without introducing a second session registry.
 */
export function createSessionAdministration(
  options: SessionAdministrationOptions,
): SessionAdministration {
  const {
    account,
    client,
    store,
    fetch = globalThis.fetch,
    logHeadMargin = 10n,
    logQueryBlockRange = 50_000n,
    logScanDepth = 100_000n,
    now = () => Math.floor(Date.now() / 1_000),
    resolveAccount,
  } = options
  const resolvedChainId = client.chain?.id
  if (resolvedChainId === undefined)
    throw new Error('Session administration requires a chain-aware client.')
  const chainId: number = resolvedChainId

  const list = (filter: SqliteSessionListOptions = {}) =>
    store.listSessions({ ...filter, chainId, payer: filter.payer ?? account.address })

  async function discover(): Promise<void> {
    const existing = new Set(list().map((record) => record.entry.channelId.toLowerCase()))
    const head = await getBlockNumber(client)
    const latest = head > logHeadMargin ? head - logHeadMargin : 0n
    const earliest = latest > logScanDepth ? latest - logScanDepth : 0n
    const openedEvent = escrowAbi.find(
      (item) => item.type === 'event' && item.name === 'ChannelOpened',
    )
    if (!openedEvent) throw new Error('TIP-1034 ChannelOpened event is unavailable.')

    let end = latest
    while (end >= earliest) {
      const start = end > earliest + logQueryBlockRange ? end - logQueryBlockRange : earliest
      const logs = await getLogs(client, {
        address: tip20ChannelEscrow,
        event: openedEvent,
        args: { payer: account.address },
        fromBlock: start,
        toBlock: end,
      } as never)
      for (const log of logs as Array<{ args?: Record<string, unknown> }>) {
        const args = log.args
        if (!args) continue
        const channelId = readHex(args.channelId, 32)
        if (!channelId || existing.has(channelId.toLowerCase())) continue
        const descriptor = readDescriptor(args)
        if (!descriptor) continue
        const state = await Chain.getChannelState(client, channelId, tip20ChannelEscrow)
        if (state.deposit === 0n) continue
        const gracePeriod = await readCloseGracePeriod(client)
        const closeRequestedAt = state.closeRequestedAt
        const graceReadyAt = closeRequestedAt === 0 ? 0 : closeRequestedAt + gracePeriod
        const timestamp = now()
        store.setSession({
          acceptedCumulative: state.settled,
          closeRequestedAt,
          createdAt: timestamp,
          entry: {
            chainId,
            channelId,
            cumulativeAmount: state.settled,
            deposit: state.deposit,
            descriptor,
            escrow: tip20ChannelEscrow,
            opened: closeRequestedAt === 0,
          },
          graceReadyAt,
          lastUsedAt: timestamp,
          origin: '',
          requestUrl: '',
          state:
            closeRequestedAt === 0 ? 'orphaned' : graceReadyAt <= now() ? 'finalizable' : 'closing',
        })
        existing.add(channelId.toLowerCase())
      }
      if (start === earliest) break
      end = start - 1n
    }
  }

  async function sync(
    syncOptions: { discover?: boolean | undefined } = {},
  ): Promise<SqliteSessionRecord[]> {
    if (syncOptions.discover ?? true) await discover()
    for (const record of list()) {
      const state = await Chain.getChannelState(client, record.entry.channelId, record.entry.escrow)
      if (state.deposit === 0n) {
        store.deleteChannel(record.entry.channelId)
        continue
      }
      const gracePeriod = await readCloseGracePeriod(client, record.entry.escrow)
      const closeRequestedAt = state.closeRequestedAt
      const graceReadyAt = closeRequestedAt === 0 ? 0 : closeRequestedAt + gracePeriod
      store.setSession({
        ...record,
        acceptedCumulative:
          state.settled > record.acceptedCumulative ? state.settled : record.acceptedCumulative,
        closeRequestedAt,
        entry: {
          ...record.entry,
          cumulativeAmount:
            state.settled > record.entry.cumulativeAmount
              ? state.settled
              : record.entry.cumulativeAmount,
          deposit: state.deposit,
          opened: closeRequestedAt === 0,
        },
        graceReadyAt,
        state:
          closeRequestedAt === 0
            ? record.origin
              ? 'active'
              : 'orphaned'
            : graceReadyAt <= now()
              ? 'finalizable'
              : 'closing',
      })
    }
    return list()
  }

  async function closeOne(
    record: SqliteSessionRecord,
    selection: SessionCloseSelection,
  ): Promise<SessionCloseResult> {
    const signingAccount = resolveAccount
      ? await resolveAccount(record.entry.descriptor.authorizedSigner)
      : account
    if (signingAccount.address.toLowerCase() !== account.address.toLowerCase())
      throw new Error('Resolved session signer does not control the configured payer account.')

    if (selection.cooperative) {
      if (!record.requestUrl)
        throw new Error('Cooperative close requires the original protected request URL.')
      const challengeResponse = await fetch(record.requestUrl, { method: 'POST' })
      const challenge = Challenge.fromResponseList(challengeResponse).find(
        (candidate) =>
          isTempoSessionChallenge(candidate) && challengeMatchesSession(candidate, record),
      )
      if (!challenge) throw new Error('Service did not return a Tempo session challenge.')
      const cumulativeAmount =
        record.acceptedCumulative > record.entry.cumulativeAmount
          ? record.acceptedCumulative
          : record.entry.cumulativeAmount
      const payload = await ChannelOps.createClosePayload(
        client,
        signingAccount,
        record.entry.descriptor,
        cumulativeAmount,
        record.entry.chainId,
        record.entry.escrow,
      )
      const response = await fetch(record.requestUrl, {
        method: 'POST',
        headers: {
          Authorization: Credential.serialize({
            challenge,
            payload,
            source: `did:pkh:eip155:${record.entry.chainId}:${signingAccount.address}`,
          }),
        },
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(body.trim() || `Cooperative close failed with HTTP ${response.status}.`)
      }
      store.deleteChannel(record.entry.channelId)
      return closeResult(record, 'closed')
    }

    const state = await Chain.getChannelState(client, record.entry.channelId, record.entry.escrow)
    if (state.deposit === 0n) {
      store.deleteChannel(record.entry.channelId)
      return closeResult(record, 'closed')
    }
    const gracePeriod = await readCloseGracePeriod(client, record.entry.escrow)
    if (state.closeRequestedAt === 0) {
      if (selection.finalize)
        return closeResult(record, 'pending', { remainingSeconds: gracePeriod })
      await Chain.requestCloseOnChain(client, record.entry.descriptor, record.entry.escrow, {
        account: signingAccount,
        feeToken: record.entry.descriptor.token,
      })
      const requestedAt = now()
      store.updateSessionState(record.entry.channelId, 'closing', {
        closeRequestedAt: requestedAt,
        graceReadyAt: requestedAt + gracePeriod,
      })
      return closeResult(record, 'pending', { remainingSeconds: gracePeriod })
    }
    const readyAt = state.closeRequestedAt + gracePeriod
    if (now() < readyAt) {
      store.updateSessionState(record.entry.channelId, 'closing', {
        closeRequestedAt: state.closeRequestedAt,
        graceReadyAt: readyAt,
      })
      return closeResult(record, 'pending', { remainingSeconds: readyAt - now() })
    }
    await Chain.withdrawOnChain(client, record.entry.descriptor, record.entry.escrow, {
      account: signingAccount,
      feeToken: record.entry.descriptor.token,
    })
    store.deleteChannel(record.entry.channelId)
    return closeResult(record, 'closed')
  }

  async function close(selection: SessionCloseSelection): Promise<SessionCloseSummary> {
    if (selection.cooperative && (selection.all || selection.orphaned || selection.finalize))
      throw new Error('Cooperative close cannot be combined with all, orphaned, or finalize.')
    const records = await sync({
      discover: selection.all || selection.orphaned || selection.finalize,
    })
    const selected = selectSessions(records, selection)
    const summary: SessionCloseSummary = { closed: 0, failed: 0, pending: 0, results: [] }
    for (const record of selected) {
      try {
        const result = await closeOne(record, selection)
        summary.results.push(result)
        if (result.status === 'closed') summary.closed += 1
        else if (result.status === 'pending') summary.pending += 1
        else summary.failed += 1
      } catch (error) {
        summary.failed += 1
        summary.results.push(
          closeResult(record, 'error', {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
    return summary
  }

  return { close, list, sync }
}

function resolveOrigin(requestUrl: string, fallback: string): string {
  try {
    return new URL(requestUrl).origin
  } catch {
    return fallback
  }
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

function sessionRecordFromRow(row: ChannelRow): SqliteSessionRecord {
  return {
    acceptedCumulative: BigInt(row.accepted_cumulative),
    closeRequestedAt: row.close_requested_at,
    createdAt: row.created_at,
    entry: entryFromRow(row),
    graceReadyAt: row.grace_ready_at,
    lastUsedAt: row.last_used_at,
    origin: row.origin,
    requestUrl: row.request_url,
    state: sessionState(row.state),
  }
}

function sessionState(value: string): SqliteSessionState {
  if (
    value === 'closing' ||
    value === 'finalizable' ||
    value === 'finalized' ||
    value === 'orphaned'
  )
    return value
  return 'active'
}

function readDescriptor(args: Record<string, unknown>): ChannelEntry['descriptor'] | undefined {
  const payer = readAddress(args.payer)
  const payee = readAddress(args.payee)
  const operator = readAddress(args.operator)
  const token = readAddress(args.token)
  const authorizedSigner = readAddress(args.authorizedSigner)
  const salt = readHex(args.salt, 32)
  const expiringNonceHash = readHex(args.expiringNonceHash, 32)
  if (!payer || !payee || !operator || !token || !authorizedSigner || !salt || !expiringNonceHash)
    return undefined
  return { authorizedSigner, expiringNonceHash, operator, payee, payer, salt, token }
}

function readAddress(value: unknown): Address | undefined {
  return readHex(value, 20) as Address | undefined
}

function readHex(value: unknown, bytes: number): Hex | undefined {
  return typeof value === 'string' &&
    new RegExp(`^0x[0-9a-fA-F]{${String(bytes * 2)}}$`).test(value)
    ? (value.toLowerCase() as Hex)
    : undefined
}

async function readCloseGracePeriod(
  client: Client,
  escrow: Address = tip20ChannelEscrow,
): Promise<number> {
  try {
    const value = await readContract(client, {
      address: escrow,
      abi: escrowAbi,
      functionName: 'CLOSE_GRACE_PERIOD',
    })
    if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
      return Number(value)
  } catch {}
  return 900
}

function selectSessions(
  records: SqliteSessionRecord[],
  selection: SessionCloseSelection,
): SqliteSessionRecord[] {
  if (selection.all) return records
  if (selection.finalize) return records.filter((record) => record.state === 'finalizable')
  if (selection.orphaned) return records.filter((record) => record.state === 'orphaned')
  if (!selection.target)
    throw new Error('Specify a URL, channel ID, or all/orphaned/finalize session selection.')
  const channelId = readHex(selection.target, 32)
  if (channelId)
    return records.filter(
      (record) => record.entry.channelId.toLowerCase() === channelId.toLowerCase(),
    )
  const origin = normalizeOrigin(selection.target)
  return records.filter((record) => normalizeOrigin(record.origin) === origin)
}

function challengeMatchesSession(
  challenge: Challenge.Challenge,
  record: SqliteSessionRecord,
): boolean {
  const request = challenge.request
  if (
    typeof request.currency === 'string' &&
    request.currency.toLowerCase() !== record.entry.descriptor.token.toLowerCase()
  )
    return false
  if (
    typeof request.recipient === 'string' &&
    request.recipient.toLowerCase() !== record.entry.descriptor.payee.toLowerCase()
  )
    return false
  const details =
    request.methodDetails && typeof request.methodDetails === 'object'
      ? (request.methodDetails as Record<string, unknown>)
      : {}
  if (typeof details.chainId === 'number' && details.chainId !== record.entry.chainId) return false
  const escrow =
    typeof details.escrowContract === 'string'
      ? details.escrowContract
      : typeof details.escrow === 'string'
        ? details.escrow
        : undefined
  return !escrow || escrow.toLowerCase() === record.entry.escrow.toLowerCase()
}

function closeResult(
  record: SqliteSessionRecord,
  status: SessionCloseResult['status'],
  extra: {
    error?: string | undefined
    remainingSeconds?: number | undefined
  } = {},
): SessionCloseResult {
  return {
    channelId: record.entry.channelId,
    status,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.remainingSeconds !== undefined ? { remainingSeconds: extra.remainingSeconds } : {}),
  }
}

function scopedKey(namespace: string, key: string): string {
  return `${namespace}\n${key}`
}

function mergeEntry(current: ChannelEntry | undefined, incoming: ChannelEntry): ChannelEntry {
  if (!current || current.channelId.toLowerCase() !== incoming.channelId.toLowerCase())
    return incoming
  return {
    ...incoming,
    cumulativeAmount:
      current.cumulativeAmount > incoming.cumulativeAmount
        ? current.cumulativeAmount
        : incoming.cumulativeAmount,
    deposit: current.deposit > incoming.deposit ? current.deposit : incoming.deposit,
  }
}

function entryFromRow(row: ChannelRow): ChannelEntry {
  if (row.entry_json) {
    const stored = JSON.parse(row.entry_json) as StoredChannel
    return deserializeEntry({ ...stored, opened: row.state === 'active' })
  }

  if (!row.descriptor_json) throw new Error('v2 channel row is missing its descriptor')
  const descriptor = JSON.parse(row.descriptor_json) as ChannelEntry['descriptor']
  return {
    channelId: row.channel_id as ChannelEntry['channelId'],
    cumulativeAmount: BigInt(row.cumulative_amount),
    deposit: BigInt(row.deposit),
    descriptor,
    escrow: row.escrow_contract as ChannelEntry['escrow'],
    chainId: row.chain_id,
    opened: row.state === 'active',
  }
}

function ensureSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    scope_key TEXT,
    origin TEXT NOT NULL,
    request_url TEXT NOT NULL DEFAULT '',
    chain_id INTEGER NOT NULL,
    escrow_contract TEXT NOT NULL,
    token TEXT NOT NULL,
    payee TEXT NOT NULL,
    payer TEXT NOT NULL,
    authorized_signer TEXT NOT NULL,
    salt TEXT NOT NULL,
    deposit TEXT NOT NULL,
    cumulative_amount TEXT NOT NULL,
    challenge_echo TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    close_requested_at INTEGER NOT NULL DEFAULT 0,
    grace_ready_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    accepted_cumulative TEXT NOT NULL DEFAULT '0',
    server_spent TEXT NOT NULL DEFAULT '0',
    session_protocol TEXT NOT NULL DEFAULT 'v1',
    descriptor_json TEXT,
    entry_json TEXT
  )`)
  addColumn(database, 'scope_key TEXT')
  addColumn(database, 'entry_json TEXT')
  database.exec(`UPDATE channels
    SET scope_key = origin || char(10) || lower(payee) || ':' || lower(token) || ':' ||
      lower(escrow_contract) || ':' || chain_id
    WHERE scope_key IS NULL AND origin <> '' AND session_protocol = 'v2'
      AND descriptor_json IS NOT NULL`)
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_scope_key ON channels(scope_key) WHERE scope_key IS NOT NULL',
  )
  database.exec('CREATE INDEX IF NOT EXISTS idx_channels_origin ON channels(origin)')
}

function addColumn(database: DatabaseSync, definition: string): void {
  const name = definition.slice(0, definition.indexOf(' '))
  const columns = database.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>
  if (columns.some((column) => column.name === name)) return
  database.exec(`ALTER TABLE channels ADD COLUMN ${definition}`)
}
