import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ChannelEntry } from '../tempo/session/client/ChannelOps.js'
import {
  deserializeEntry,
  entryKey,
  serializeEntry,
  type ChannelStore,
  type StoredChannel,
} from '../tempo/session/client/ChannelStore.js'

const schemaVersion = 2

/** Options for the Node SQLite-backed payer channel store. */
export type SqliteChannelStoreOptions = {
  /** Service namespace, normally the protected API origin. */
  namespace?: string | undefined
  /** SQLite file path. Defaults to Tempo Wallet's shared channel database. */
  path?: string | undefined
  /** Full protected URL retained for CLI session-management requests. */
  requestUrl?: string | undefined
}

/** A SQLite-backed channel store that can release its database handle. */
export type SqliteChannelStore = ChannelStore & {
  /** Absolute or caller-supplied path opened by this store. */
  readonly path: string
  /** Closes the underlying SQLite connection. */
  close(): void
}

type ChannelRow = {
  chain_id: number
  channel_id: string
  cumulative_amount: string
  deposit: string
  descriptor_json: string | null
  entry_json: string | null
  escrow_contract: string
  state: string
}

/** Returns the channel database shared by Tempo command-line applications. */
export function defaultChannelDatabasePath(): string {
  return join(homedir(), '.tempo', 'wallet', 'channels.db')
}

/**
 * Creates a synchronous Node SQLite implementation of {@link ChannelStore}.
 *
 * The schema is compatible with Tempo Wallet's existing `channels` table, so
 * a fresh MPPx client can reuse v2 session records without a separate migration
 * command. A namespace keeps identical payment scopes at different services
 * isolated from one another.
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
  const deleteScope = database.prepare('DELETE FROM channels WHERE scope_key = ?')
  const deleteOtherScopeChannel = database.prepare(
    'DELETE FROM channels WHERE scope_key = ? AND channel_id <> ?',
  )
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
    close() {
      database.close()
    },
  }
}

function resolveOrigin(requestUrl: string, fallback: string): string {
  try {
    return new URL(requestUrl).origin
  } catch {
    return fallback
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
    WHERE scope_key IS NULL AND session_protocol = 'v2' AND descriptor_json IS NOT NULL`)
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
